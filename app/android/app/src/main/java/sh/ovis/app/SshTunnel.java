package sh.ovis.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.LongSupplier;

/**
 * The WebView's way to one SSH PC: a listener on the PC's loopback origin on this phone, each of whose
 * connections becomes an SSH channel (direct-tcpip) to the PC's own Ovis on its 127.0.0.1. That Ovis
 * sees a request from its own loopback with no proxy headers, which it lets in as its own PC's
 * (server/access.ts decideAccess, `local`): no token is typed or kept.
 *
 * <p>Every app on the phone can reach the phone's loopback, so a connection is passed on only when its
 * first request carries the PC's gate cookie, which the app put in the WebView's cookie store and no
 * other app can read; anything else gets 403 and nothing reaches the PC.
 *
 * <p>Lifetime rules (SshTunnelTest checks each, with this class's clock and dialer injected):
 * <ul>
 *   <li>the SSH connection is made when a request needs it, never before, and made again on the next
 *       request after it ended (the app in the background, a network change: `drop`), asking nothing;</li>
 *   <li>a request is passed on once, as it came: a request cut by a drop is never sent again, so
 *       nothing typed is sent twice (the page keeps it as a draft);</li>
 *   <li>a failure is answered at once, for RETRY_AFTER_MS, to every request of the page's burst, then
 *       tried again; a stop (SshFailure.stops: the host key, the key refused) is never tried again by
 *       this tunnel: only setting the PC up again makes another;</li>
 *   <li>`wake` (the app back in front) checks a connection with a ping and makes a new one before the
 *       page asks, when it no longer answers.</li>
 * </ul>
 * A failed request gets 503 with an `X-Ovis-Ssh` header naming the failure's kind; the listener hears
 * every failure, so the app's error page can say what happened and what to do.
 */
final class SshTunnel {
    static final String GATE_COOKIE = "ovis_ssh_gate";
    static final String FAILURE_HEADER = "X-Ovis-Ssh";
    /** a failure is not retried for this long: the page's burst of requests gets the same answer at once */
    static final long RETRY_AFTER_MS = 2_000;
    private static final int HEAD_LIMIT = 64 * 1024;

    /** One SSH connection made for the tunnel, to the PC's Ovis. */
    interface Link {
        /** A new channel to the PC's Ovis. */
        Channel open() throws IOException;

        /** Looks up the PC's Ovis again (it may have restarted on another port). */
        void relocate() throws SshFailure;

        /** Whether the connection still answers, within a few seconds. */
        boolean alive();

        void close();

        /** Runs `ended` once the connection ends, whoever ends it. */
        void onEnd(Runnable ended);
    }

    interface Channel {
        InputStream input() throws IOException;

        OutputStream output() throws IOException;

        void close();
    }

    /** Connects, signs in and finds the PC's Ovis: a Link, or why not. */
    interface Dialer {
        Link dial() throws SshFailure;
    }

    interface Listener {
        void onFailure(SshFailure failure);
    }

    private final String gate;
    private final InetAddress bindHost;
    private final int bindPort;
    private final Dialer dialer;
    private final LongSupplier clock;
    private final Listener listener;
    private final ExecutorService pipes = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "ovis-ssh-pipe");
        thread.setDaemon(true);
        return thread;
    });
    private ServerSocket server;
    private Link link;
    private SshFailure lastFailure;
    private long failedAt;
    private SshFailure stopped;

    SshTunnel(String gate, InetAddress bindHost, int bindPort, Dialer dialer, LongSupplier clock, Listener listener) {
        this.gate = gate;
        this.bindHost = bindHost;
        this.bindPort = bindPort;
        this.dialer = dialer;
        this.clock = clock;
        this.listener = listener;
    }

    /** Starts listening; the port it listens on (bindPort, or the one picked for 0). */
    int listen() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(bindHost, bindPort), 64);
        Thread accept = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    pipes.execute(() -> serve(client));
                } catch (IOException | java.util.concurrent.RejectedExecutionException closed) {
                    return;
                }
            }
        }, "ovis-ssh-accept");
        accept.setDaemon(true);
        accept.start();
        return server.getLocalPort();
    }

    void close() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // closing a listener that is already gone
        }
        drop();
        pipes.shutdownNow();
    }

    /** Ends the SSH connection (a network change): the next request makes a new one. */
    void drop() {
        Link was;
        synchronized (this) {
            was = link;
            link = null;
        }
        if (was != null) was.close();
    }

    /** The app came back: a connection that no longer answers is dropped and made again before the page asks. */
    void wake() {
        Link now;
        synchronized (this) {
            now = link;
        }
        if (now != null && !now.alive()) {
            synchronized (this) {
                if (link == now) link = null;
            }
            now.close();
        }
        try {
            ready();
        } catch (SshFailure failed) {
            // the page's next request is told, and the listener was
        }
    }

    synchronized SshFailure stoppedBy() {
        return stopped;
    }

    private synchronized Link ready() throws SshFailure {
        if (stopped != null) {
            listener.onFailure(stopped);
            throw stopped;
        }
        if (link != null) return link;
        if (lastFailure != null && clock.getAsLong() - failedAt < RETRY_AFTER_MS) {
            listener.onFailure(lastFailure);
            throw lastFailure;
        }
        Link made;
        try {
            made = dialer.dial();
        } catch (SshFailure failed) {
            remember(failed);
            throw failed;
        }
        made.onEnd(() -> {
            synchronized (SshTunnel.this) {
                if (link == made) link = null;
            }
        });
        link = made;
        lastFailure = null;
        return made;
    }

    private void remember(SshFailure failed) {
        lastFailure = failed;
        failedAt = clock.getAsLong();
        if (failed.stops()) stopped = failed;
        listener.onFailure(failed);
    }

    /** A channel to the PC's Ovis; after a failed open the Ovis is looked up again once. */
    private Channel channel() throws SshFailure {
        Link now = ready();
        try {
            return now.open();
        } catch (IOException refused) {
            try {
                now.relocate();
                return now.open();
            } catch (SshFailure gone) {
                synchronized (this) {
                    remember(gone);
                }
                throw gone;
            } catch (IOException again) {
                synchronized (this) {
                    if (link == now) link = null;
                }
                now.close();
                SshFailure failed = new SshFailure("unreachable", SshFailure.rootMessage(again));
                synchronized (this) {
                    remember(failed);
                }
                throw failed;
            }
        }
    }

    private void serve(Socket client) {
        try {
            client.setSoTimeout(15_000);
            InputStream fromPage = client.getInputStream();
            OutputStream toPage = client.getOutputStream();
            byte[] head = readHead(fromPage);
            if (head == null || !carriesGate(head, gate)) {
                toPage.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                toPage.flush();
                client.close();
                return;
            }
            Channel stream;
            try {
                stream = channel();
            } catch (SshFailure failed) {
                byte[] body = (failed.kind + ": " + failed.getMessage()).getBytes(StandardCharsets.UTF_8);
                toPage.write((
                    "HTTP/1.1 503 Service Unavailable\r\n" + FAILURE_HEADER + ": " + failed.kind.replaceAll("[^a-z-]", "") +
                    "\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: " + body.length +
                    "\r\nConnection: close\r\n\r\n"
                ).getBytes(StandardCharsets.US_ASCII));
                toPage.write(body);
                toPage.flush();
                client.close();
                return;
            }
            client.setSoTimeout(0);
            OutputStream toPc = stream.output();
            toPc.write(head);
            toPc.flush();
            InputStream fromPc = stream.input();
            pipes.execute(() -> pump(fromPage, toPc, client, stream));
            pump(fromPc, toPage, client, stream);
        } catch (IOException | java.util.concurrent.RejectedExecutionException ended) {
            closeQuietly(client);
        }
    }

    /**
     * The request head, up to its blank line, or null when the page closed first or sent more than
     * HEAD_LIMIT without one. Bytes after the blank line (a body) are left in the stream.
     */
    static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (head.size() < HEAD_LIMIT) {
            int next = in.read();
            if (next < 0) return null;
            head.write(next);
            matched = (next == '\r' && (matched == 0 || matched == 2)) || (next == '\n' && (matched == 1 || matched == 3)) ? matched + 1 : (next == '\r' ? 1 : 0);
            if (matched == 4) return head.toByteArray();
        }
        return null;
    }

    /** Whether a request head carries `gate` as the gate cookie, compared in constant time. */
    static boolean carriesGate(byte[] head, String gate) {
        if (gate == null || gate.isEmpty()) return false;
        String text = new String(head, StandardCharsets.ISO_8859_1);
        byte[] expected = gate.getBytes(StandardCharsets.US_ASCII);
        for (String line : text.split("\r\n")) {
            if (!line.toLowerCase(Locale.ROOT).startsWith("cookie:")) continue;
            for (String pair : line.substring("cookie:".length()).split(";")) {
                String[] parts = pair.trim().split("=", 2);
                if (parts.length == 2 && parts[0].equals(GATE_COOKIE) && MessageDigest.isEqual(parts[1].getBytes(StandardCharsets.US_ASCII), expected)) return true;
            }
        }
        return false;
    }

    private static void pump(InputStream from, OutputStream to, Socket client, Channel stream) {
        byte[] buffer = new byte[32 * 1024];
        try {
            int read;
            while ((read = from.read(buffer)) >= 0) {
                to.write(buffer, 0, read);
                to.flush();
            }
        } catch (IOException ended) {
            // either side went away
        } finally {
            closeQuietly(client);
            stream.close();
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }
}
