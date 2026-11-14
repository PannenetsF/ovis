package sh.ovis.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import com.trilead.ssh2.Connection;
import java.io.IOException;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.Map;

/**
 * The phone's SshTunnels, one per saved SSH PC for the process's life, and what they share: the
 * dialer that signs in with the PC's saved key and host key, a network watch that drops every SSH
 * connection when the phone's network changes (one made over the network before may never hear that
 * it is gone), and the listener that hands a failure to the app (OvisSshPlugin).
 */
final class SshTunnels {
    interface FailureListener {
        void onFailure(SshPcs.Pc pc, SshFailure failure);
    }

    private static final class Entry {
        final SshPcs.Pc pc;
        final SshTunnel tunnel;

        Entry(SshPcs.Pc pc, SshTunnel tunnel) {
            this.pc = pc;
            this.tunnel = tunnel;
        }
    }

    private static final Map<String, Entry> tunnels = new HashMap<>();
    static volatile FailureListener listener;
    private static ConnectivityManager.NetworkCallback networkWatch;

    private SshTunnels() {}

    /** The tunnel for `pc`, listening: kept while the PC's saved way in stays the same. */
    static synchronized SshTunnel open(Context context, SshPcs.Pc pc) throws IOException {
        Context app = context.getApplicationContext();
        Entry entry = tunnels.get(pc.origin);
        if (entry != null && same(entry.pc, pc)) return entry.tunnel;
        if (entry != null) entry.tunnel.close();
        SshTunnel tunnel = new SshTunnel(
            pc.gate,
            InetAddress.getByName(pc.loopbackHost()),
            SshPcs.LOCAL_PORT,
            () -> dial(app, pc),
            System::currentTimeMillis,
            failure -> {
                FailureListener told = listener;
                if (told != null) told.onFailure(pc, failure);
            }
        );
        tunnel.listen();
        tunnels.put(pc.origin, new Entry(pc, tunnel));
        watchNetwork(app);
        return tunnel;
    }

    private static boolean same(SshPcs.Pc a, SshPcs.Pc b) {
        return a.hostKey.equals(b.hostKey) && a.hostKeyAlgorithm.equals(b.hostKeyAlgorithm) && a.gate.equals(b.gate)
            && a.auth.equals(b.auth) && a.importedKey.equals(b.importedKey) && a.host.equals(b.host) && a.port == b.port && a.user.equals(b.user);
    }

    /** Connects to `pc` with what was saved when it was added: its host key, and its key. Never asks anything. */
    static SshTunnel.Link dial(Context app, SshPcs.Pc pc) throws SshFailure {
        if (!pc.hasHostKey()) throw new SshFailure("host-key-unknown", "The host key is not confirmed");
        SshPcs store = SshPcs.on(app);
        Connection made = SshLink.connect(pc.host, pc.port, new SshLink.HostKeyCheck(pc.hostKeyAlgorithm, pc.hostKey));
        try {
            SshLink.signIn(made, pc.user, "imported".equals(pc.auth) ? store.importedKey(pc) : store.phoneKey());
            return SshLink.link(made, SshLink.ovisPort(made));
        } catch (SshFailure failed) {
            made.close();
            throw failed;
        } catch (RuntimeException unexpected) {
            made.close();
            throw new SshFailure("internal", SshFailure.rootMessage(unexpected));
        }
    }

    static synchronized void closeFor(String origin) {
        Entry entry = tunnels.remove(origin);
        if (entry != null) entry.tunnel.close();
    }

    /** The app came back: each tunnel checks its connection and makes a new one before the page asks. */
    static void wakeAll() {
        for (SshTunnel tunnel : all()) new Thread(tunnel::wake, "ovis-ssh-wake").start();
    }

    private static synchronized SshTunnel[] all() {
        SshTunnel[] list = new SshTunnel[tunnels.size()];
        int at = 0;
        for (Entry entry : tunnels.values()) list[at++] = entry.tunnel;
        return list;
    }

    private static void watchNetwork(Context app) {
        if (networkWatch != null) return;
        ConnectivityManager manager = app.getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        networkWatch = new ConnectivityManager.NetworkCallback() {
            private Network current;

            @Override
            public void onAvailable(Network network) {
                Network before = current;
                current = network;
                // the first call names the network there already is; a later one is a switch
                if (before != null && !before.equals(network)) dropAll();
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(current)) current = null;
                dropAll();
            }
        };
        manager.registerDefaultNetworkCallback(networkWatch);
    }

    private static void dropAll() {
        for (SshTunnel tunnel : all()) tunnel.drop();
    }
}
