package ai.openclaw.android.security

import ai.openclaw.android.SecurePrefs

/** Loads secrets from keystore-backed prefs at process startup into memory. */
class RuntimeSecretBridge(
  private val prefs: SecurePrefs,
) {
  @Volatile private var snapshot: RuntimeSecretSnapshot = RuntimeSecretSnapshot.empty()

  fun warmStart() {
    refreshInMemorySecrets()
  }

  fun refreshInMemorySecrets() {
    snapshot =
      RuntimeSecretSnapshot(
        apiKeys = prefs.loadApiKeys(),
        channelTokens = prefs.loadChannelTokens(),
      )
  }

  fun currentSnapshot(): RuntimeSecretSnapshot = snapshot

  fun apiKey(provider: String): String? {
    val key = provider.trim().lowercase()
    if (key.isEmpty()) return null
    return snapshot.apiKeys[key]
  }

  fun channelToken(channel: String): String? {
    val key = channel.trim().lowercase()
    if (key.isEmpty()) return null
    return snapshot.channelTokens[key]
  }

  fun saveApiKey(provider: String, value: String?) {
    prefs.setApiKey(provider, value)
    refreshInMemorySecrets()
  }

  fun saveChannelToken(channel: String, value: String?) {
    prefs.setChannelToken(channel, value)
    refreshInMemorySecrets()
  }
}

data class RuntimeSecretSnapshot(
  val apiKeys: Map<String, String>,
  val channelTokens: Map<String, String>,
) {
  companion object {
    fun empty(): RuntimeSecretSnapshot = RuntimeSecretSnapshot(apiKeys = emptyMap(), channelTokens = emptyMap())
  }

  fun allSecretValues(): Set<String> {
    return (apiKeys.values + channelTokens.values).map { it.trim() }.filter { it.length >= 6 }.toSet()
  }
}
