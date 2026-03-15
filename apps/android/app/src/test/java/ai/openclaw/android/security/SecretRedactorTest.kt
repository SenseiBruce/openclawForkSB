package ai.openclaw.android.security

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SecretRedactorTest {
  @Test
  fun `redacts common secret assignments`() {
    val raw = "authorization: Bearer abc123xyz\napiKey=my-secret\ntoken: supertoken"

    val redacted = SecretRedactor.redact(raw)

    assertFalse(redacted.contains("abc123xyz"))
    assertFalse(redacted.contains("my-secret"))
    assertFalse(redacted.contains("supertoken"))
    assertTrue(redacted.contains("***"))
  }

  @Test
  fun `redacts known runtime secret values`() {
    val snapshot =
      RuntimeSecretSnapshot(
        apiKeys = mapOf("elevenlabs" to "eleven-secret-value"),
        channelTokens = mapOf("discord" to "discord-token-value"),
      )

    val raw = "got eleven-secret-value and discord-token-value in stacktrace"
    val redacted = SecretRedactor.redact(raw, snapshot)

    assertFalse(redacted.contains("eleven-secret-value"))
    assertFalse(redacted.contains("discord-token-value"))
    assertTrue(redacted.contains("***"))
  }
}
