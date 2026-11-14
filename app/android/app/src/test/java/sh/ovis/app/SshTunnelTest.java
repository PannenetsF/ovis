package sh.ovis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * SshTunnel's lifetime rules, with its clock and its SSH side injected: the "network" is a dialer
 * whose links open real loopback sockets to a stand-in Ovis, so the gate and the pipes are the real
 * ones. Nothing waits on time: every wait is for an event, bounded.
 */
public class SshTunnelTest {
    private static final String GATE = "a".repeat(64);
    private static final long BOUND_S = 5;

    /** Stands in for the PC's Ovis: records each request head, answers "ok" unless held. */
    private static final class Ovis {
        final ServerSocket server;
        final BlockingQueue<String> requests = new LinkedBlockingQueue<>();
        final AtomicInteger connections = new AtomicInteger();
        volatile boolean hold;

        Ovis() throws IOException {
            server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            Thread accept = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        connections.incrementAndGet();
                        Thread serve = new Thread(() -> serve(socket));
                        serve.setDaemon(true);
                        serve.start();
                    } catch (IOException closed) {
                        return;
                    }
                }
            });
            accept.setDaemon(true);
            accept.start();
        }

        private void serve(Socket socket) {
            try (Socket s = socket) {
                byte[] head = SshTunnel.readHead(s.getInputStream());
                if (head == null) return;
                requests.add(new String(head, StandardCharsets.ISO_8859_1));
                if (hold) {
                    // the answer never comes: the request is cut when the link drops
                    s.getInputStream().read();
                    return;
                }
                s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".getBytes(StandardCharsets.US_ASCII));
            } catch (IOException ended) {
                // the tunnel closed its side
            }
        }
    }

    /** One SSH connection, as SshLink.link makes it: channels are sockets to the stand-in Ovis. */
    private final class FakeLink implements SshTunnel.Link {
        final List<Runnable> ends = new CopyOnWriteArrayList<>();
        final List<Socket> open = new CopyOnWriteArrayList<>();
        volatile boolean alive = true;
        volatile boolean closed;
        /** opens that fail before one works (an Ovis that moved), and the relocations asked */
        final AtomicInteger refusals = new AtomicInteger();
        final AtomicInteger relocations = new AtomicInteger();
        volatile SshFailure relocateFails;

        @Override
        public SshTunnel.Channel open() throws IOException {
            if (closed) throw new IOException("connection closed");
            if (refusals.getAndDecrement() > 0) throw new IOException("channel refused");
            Socket socket = new Socket(InetAddress.getLoopbackAddress(), ovis.server.getLocalPort());
            open.add(socket);
            return new SshTunnel.Channel() {
                @Override public InputStream input() throws IOException { return socket.getInputStream(); }
                @Override public OutputStream output() throws IOException { return socket.getOutputStream(); }
                @Override public void close() { try { socket.close(); } catch (IOException ignored) { /* closed */ } }
            };
        }

        @Override
        public void relocate() throws SshFailure {
            relocations.incrementAndGet();
            if (relocateFails != null) throw relocateFails;
        }

        @Override
        public boolean alive() {
            return alive;
        }

        @Override
        public void close() {
            end();
        }

        /** The connection ends (the server, the network): its channels go with it. */
        void end() {
            if (closed) return;
            closed = true;
            for (Socket socket : open) {
                try { socket.close(); } catch (IOException ignored) { /* closed */ }
            }
            for (Runnable ended : ends) ended.run();
        }

        @Override
        public void onEnd(Runnable ended) {
            ends.add(ended);
        }
    }

    private Ovis ovis;
    private final AtomicLong now = new AtomicLong(1_000_000);
    /** what each dial does, in turn: a failure to throw, or null for a new link */
    private final Deque<SshFailure> outcomes = new ArrayDeque<>();
    private final List<FakeLink> links = new CopyOnWriteArrayList<>();
    private final BlockingQueue<SshFailure> told = new LinkedBlockingQueue<>();
    private SshTunnel tunnel;
    private int port;

    @Before
    public void start() throws IOException {
        ovis = new Ovis();
        tunnel = new SshTunnel(GATE, InetAddress.getLoopbackAddress(), 0, () -> {
            SshFailure outcome;
            synchronized (outcomes) {
                outcome = outcomes.poll();
            }
            if (outcome != null) {
                links.add(null);
                throw outcome;
            }
            FakeLink link = new FakeLink();
            links.add(link);
            return link;
        }, now::get, told::add);
        port = tunnel.listen();
    }

    @After
    public void stop() throws IOException {
        tunnel.close();
        ovis.server.close();
    }

    private void dialsWill(SshFailure... failures) {
        synchronized (outcomes) {
            for (SshFailure failure : failures) outcomes.add(failure);
        }
    }

    private FakeLink link(int index) {
        return links.get(index);
    }

    private static String head(String cookie) {
        return "GET /api/health HTTP/1.1\r\nHost: 127.0.0.2:47317\r\n" + (cookie == null ? "" : "Cookie: " + cookie + "\r\n") + "\r\n";
    }

    /** One request through the tunnel, read to its end. */
    private String request(String cookie) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
            socket.setSoTimeout((int) TimeUnit.SECONDS.toMillis(BOUND_S));
            socket.getOutputStream().write(head(cookie).getBytes(StandardCharsets.US_ASCII));
            ByteArrayOutputStream answer = new ByteArrayOutputStream();
            InputStream in = socket.getInputStream();
            byte[] buffer = new byte[4096];
            for (int read; (read = in.read(buffer)) >= 0; ) answer.write(buffer, 0, read);
            return answer.toString("UTF-8");
        }
    }

    private String gated() throws IOException {
        return request(SshTunnel.GATE_COOKIE + "=" + GATE);
    }

    private SshFailure nextTold() throws InterruptedException {
        SshFailure failure = told.poll(BOUND_S, TimeUnit.SECONDS);
        assertNotNull("the listener was told nothing", failure);
        return failure;
    }

    @Test
    public void withoutTheGateNothingReachesThePc() throws IOException {
        for (String cookie : new String[] { null, "ovis_ssh_gate=" + "b".repeat(64), "other=" + GATE, "ovis_ssh_gate=" + GATE.substring(1), "Ovis_ssh_gate=" + GATE }) {
            assertTrue(String.valueOf(cookie), request(cookie).startsWith("HTTP/1.1 403 "));
        }
        assertEquals("no SSH connection was made for them", 0, links.size());
        assertEquals(0, ovis.connections.get());
    }

    @Test
    public void theGatePassesTheRequestOnceAsItCameOverOneConnection() throws Exception {
        String answer = request("theme=dark; " + SshTunnel.GATE_COOKIE + "=" + GATE);
        assertTrue(answer, answer.startsWith("HTTP/1.1 200 OK") && answer.endsWith("ok"));
        assertEquals(head("theme=dark; " + SshTunnel.GATE_COOKIE + "=" + GATE), ovis.requests.poll(BOUND_S, TimeUnit.SECONDS));
        assertTrue(gated().endsWith("ok"));
        assertEquals("the second request reuses the connection", 1, links.size());
        assertTrue(told.isEmpty());
    }

    @Test
    public void noConnectionIsMadeBeforeARequestNeedsIt() throws IOException {
        assertEquals(0, links.size());
        gated();
        assertEquals(1, links.size());
    }

    @Test
    public void aFailureAnswersTheBurstAtOnceThenIsTriedAgain() throws Exception {
        dialsWill(new SshFailure("unreachable", "Nothing answers on that SSH port"));
        String first = gated();
        assertTrue(first, first.startsWith("HTTP/1.1 503 ") && first.contains("\r\nX-Ovis-Ssh: unreachable\r\n"));
        assertEquals("unreachable", nextTold().kind);
        now.addAndGet(SshTunnel.RETRY_AFTER_MS - 1);
        assertTrue(gated().contains("X-Ovis-Ssh: unreachable"));
        assertEquals("the burst got the same answer, no new dial", 1, links.size());
        assertEquals("and the listener heard it again, for the page", "unreachable", nextTold().kind);
        now.addAndGet(1);
        assertTrue(gated().endsWith("ok"));
        assertEquals(2, links.size());
    }

    @Test
    public void aStopIsNeverTriedAgain() throws Exception {
        for (String kind : new String[] { "auth", "host-key-changed" }) {
            stop();
            outcomes.clear();
            links.clear();
            told.clear();
            start();
            dialsWill(new SshFailure(kind, "stop"));
            assertTrue(gated().contains("X-Ovis-Ssh: " + kind));
            now.addAndGet(TimeUnit.DAYS.toMillis(1));
            assertTrue(gated().contains("X-Ovis-Ssh: " + kind));
            tunnel.wake();
            assertEquals(kind, 1, links.size());
            assertEquals(kind, tunnel.stoppedBy().kind);
        }
    }

    @Test
    public void aConnectionThatEndedIsMadeAgainOnTheNextRequestAskingNothing() throws IOException {
        assertTrue(gated().endsWith("ok"));
        link(0).end();
        assertTrue(gated().endsWith("ok"));
        assertEquals(2, links.size());
        assertTrue(told.isEmpty());
    }

    @Test
    public void aNetworkChangeDropsTheConnection() throws IOException {
        gated();
        tunnel.drop();
        assertTrue(link(0).closed);
        assertTrue(gated().endsWith("ok"));
        assertEquals(2, links.size());
    }

    @Test
    public void aRequestCutByADropIsNeverSentAgain() throws Exception {
        ovis.hold = true;
        CountDownLatch cut = new CountDownLatch(1);
        String[] firstAnswer = new String[1];
        Thread page = new Thread(() -> {
            try {
                firstAnswer[0] = gated();
            } catch (IOException ended) {
                firstAnswer[0] = "ended: " + ended.getMessage();
            }
            cut.countDown();
        });
        page.start();
        assertNotNull("the request reached the PC", ovis.requests.poll(BOUND_S, TimeUnit.SECONDS));
        tunnel.drop();
        assertTrue("the page saw its request end", cut.await(BOUND_S, TimeUnit.SECONDS));
        assertFalse(firstAnswer[0], firstAnswer[0].contains("200 OK"));
        ovis.hold = false;
        assertTrue(gated().endsWith("ok"));
        assertNotNull(ovis.requests.poll(BOUND_S, TimeUnit.SECONDS));
        assertNull("the cut request was not sent again", ovis.requests.poll());
        assertEquals(2, ovis.connections.get());
    }

    @Test
    public void anOvisThatMovedIsLookedUpAgainOnce() throws Exception {
        gated();
        link(0).refusals.set(1);
        assertTrue(gated().endsWith("ok"));
        assertEquals(1, link(0).relocations.get());
        link(0).refusals.set(1);
        link(0).relocateFails = new SshFailure("no-ovis", "Ovis is not installed there", SshLink.INSTALL_COMMAND);
        assertTrue(gated().contains("X-Ovis-Ssh: no-ovis"));
        SshFailure failure = nextTold();
        assertEquals("no-ovis", failure.kind);
        assertEquals(SshLink.INSTALL_COMMAND, failure.command);
    }

    @Test
    public void wakingMakesANewConnectionOnlyForOneThatNoLongerAnswers() throws IOException {
        tunnel.wake();
        assertEquals("the app back in front connects before the page asks", 1, links.size());
        tunnel.wake();
        assertEquals(1, links.size());
        link(0).alive = false;
        tunnel.wake();
        assertTrue(link(0).closed);
        assertEquals(2, links.size());
        assertTrue(gated().endsWith("ok"));
        assertEquals(2, links.size());
    }

    @Test
    public void readsTheRequestHeadAndLeavesTheBody() throws IOException {
        byte[] request = "POST /x HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody".getBytes(StandardCharsets.US_ASCII);
        ByteArrayInputStream in = new ByteArrayInputStream(request);
        assertArrayEquals("POST /x HTTP/1.1\r\nContent-Length: 4\r\n\r\n".getBytes(StandardCharsets.US_ASCII), SshTunnel.readHead(in));
        assertEquals("body", new String(in.readAllBytes(), StandardCharsets.US_ASCII));
        assertNull(SshTunnel.readHead(new ByteArrayInputStream("GET / HTTP/1.1\r\n".getBytes(StandardCharsets.US_ASCII))));
        assertNull(SshTunnel.readHead(new ByteArrayInputStream(("GET /" + "a".repeat(70_000)).getBytes(StandardCharsets.US_ASCII))));
    }

    @Test
    public void theGateIsReadFromAnyCookieHeaderAndNothingElse() {
        assertTrue(SshTunnel.carriesGate(head("a=1").replace("\r\n\r\n", "\r\ncookie:  ovis_ssh_gate=" + GATE + " ; b=2\r\n\r\n").getBytes(StandardCharsets.US_ASCII), GATE));
        assertFalse(SshTunnel.carriesGate(("GET /?ovis_ssh_gate=" + GATE + " HTTP/1.1\r\nX-Cookie: ovis_ssh_gate=" + GATE + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII), GATE));
        assertFalse(SshTunnel.carriesGate(head("ovis_ssh_gate=").getBytes(StandardCharsets.US_ASCII), ""));
    }
}
