package ai.openclaw.android.security

object SecretRedactor {
  private val assignmentPatterns =
    listOf(
      Regex("""(?i)(authorization\s*:\s*bearer\s+)([^\s,;\"]+)"""),
      Regex("""(?i)((?:api|access|auth|gateway|channel|bot|bearer|secret|password|token|key)[\w.-]*\s*[=:]\s*)([^\s,;\"]+)"""),
      Regex("""(?i)(\"(?:apiKey|token|password|secret|authorization)\"\s*:\s*\")([^\"]+)(\")"""),
    )

  fun redact(
    input: String,
    runtimeSecrets: RuntimeSecretSnapshot? = null,
  ): String {
    if (input.isEmpty()) return input
    var redacted = input
    for (pattern in assignmentPatterns) {
      redacted =
        pattern.replace(redacted) { match ->
          when (match.groupValues.size) {
            4 -> "${match.groupValues[1]}***${match.groupValues[3]}"
            else -> "${match.groupValues[1]}***"
          }
        }
    }

    runtimeSecrets?.allSecretValues()?.forEach { secret ->
      redacted = redacted.replace(secret, "***")
    }

    return redacted
  }
}
