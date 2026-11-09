cat > tmp/cards/fix-plain-network-errors/write-red.py <<'PY'
from pathlib import Path
p=Path('android/app/src/test/java/com/usdtwallet/app/NetworkErrorTest.kt')
p.write_text('''package com.usdtwallet.app

import com.usdtwallet.app.ui.friendlyError
import com.usdtwallet.app.ui.sendError
import com.usdtwallet.app.ui.statusError
import org.junit.Assert.*
import org.junit.Test

internal const val DEADLINE_ETH = "bridge: reading the USDT permission: rpc: batch: context deadline exceeded: Post \\"http://127.0.0.1:1234\\": context deadline exceeded"
internal const val DEADLINE_TRON = "bridge: reading the Tron USDT permission: tron node /wallet/triggerconstantcontract: context deadline exceeded: Post \\"http://127.0.0.1:1234/wallet/triggerconstantcontract\\": context deadline exceeded"
internal const val CONNECTION_COPY = "The connection didn't answer in time. Try again."

class NetworkErrorTest {
    private val network = listOf("context deadline exceeded", DEADLINE_ETH, DEADLINE_TRON,
        "rpc: after 2 attempts: context deadline exceeded", "timeout", "timed out", "i/o timeout",
        "CoNtExT DeAdLiNe ExCeEdEd", "EOF", "unexpected eof", "TLS handshake failed",
        "SOCKS handshake failed", "socks connect failed", "connection reset", "connection refused",
        "broken pipe", "no route to host", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504")

    @Test fun everyExistingFormatterExplainsTransportErrors() {
        for (message in network) for ((name, formatter) in listOf(
            "home" to ::friendlyError, "send" to ::sendError, "status" to ::statusError)) {
            assertEquals("$name: $message", CONNECTION_COPY, formatter(message))
        }
    }
    @Test fun noticesDoNotPersistRawTransportCopy() {
        assertEquals("$CONNECTION_COPY Nothing more is signed until you tap Try again.", errorNotice(DEADLINE_ETH))
    }
    @Test fun localStorageTimeoutKeepsItsMeaning() {
        assertEquals("Local storage timeout", friendlyError("Local storage timeout"))
    }
    @Test fun malformedResponseNeverLeaksTheEndpoint() {
        val shown = friendlyError("invalid character '<' reading body: Post http://private.onion/wallet")
        assertFalse(shown, shown.contains("http", true))
        assertFalse(shown, shown.contains("Post"))
    }
}
''')
p=Path('core/internal/bridge/check_test.go')
p.write_text(p.read_text()+'''
// The pause sentinel and original read error must both survive to mobile.
func TestCheckReadErrorIdentity(t *testing.T) {
    for _, element := range []bool{false, true} {
        f := ethGood(t)
        if element { f.elemErr = map[int]error{0: context.DeadlineExceeded} } else { f.batchErr = context.DeadlineExceeded }
        err := CheckETH(context.Background(), f)
        if !errors.Is(err, ErrPaused) || !errors.Is(err, context.DeadlineExceeded) { t.Fatalf("ETH identity: %v", err) }
    }
    from := tron.AddressFromEth(Ethereum.Mesh)
    f := tronGood(t)
    f.contractErr = context.DeadlineExceeded
    err := CheckTron(context.Background(), f, from)
    if !errors.Is(err, ErrPaused) || !errors.Is(err, context.DeadlineExceeded) { t.Fatalf("Tron identity: %v", err) }
}
''')
PY
python3 tmp/cards/fix-plain-network-errors/write-red.py