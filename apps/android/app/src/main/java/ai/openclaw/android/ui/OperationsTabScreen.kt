package ai.openclaw.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ai.openclaw.android.MainViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class LogFilter(val label: String) {
  All("All"),
  Warnings("Warnings"),
  Errors("Errors"),
}

@Composable
fun OperationsTabScreen(viewModel: MainViewModel) {
  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val nodeConnected by viewModel.isNodeConnected.collectAsState()
  val channels by viewModel.operationsChannelStates.collectAsState()
  val diagnostics by viewModel.operationsDiagnostics.collectAsState()
  val logs by viewModel.operationsLogs.collectAsState()

  var filter by rememberSaveable { mutableStateOf(LogFilter.All) }
  var query by rememberSaveable { mutableStateOf("") }
  var redactSensitive by rememberSaveable { mutableStateOf(true) }

  val uriHandler = LocalUriHandler.current
  val fmt = remember { SimpleDateFormat("HH:mm:ss", Locale.US) }

  val filteredLogs =
    remember(logs, filter, query, redactSensitive) {
      logs.filter { entry ->
        val matchesLevel =
          when (filter) {
            LogFilter.All -> true
            LogFilter.Warnings -> entry.level.equals("warn", ignoreCase = true) || entry.level.equals("warning", ignoreCase = true)
            LogFilter.Errors -> entry.level.equals("error", ignoreCase = true)
          }
        val rawMessage = if (redactSensitive) redactForUi(entry.message) else entry.message
        val matchesQuery = query.isBlank() || rawMessage.contains(query, ignoreCase = true) || entry.source.contains(query, ignoreCase = true)
        matchesLevel && matchesQuery
      }.takeLast(120)
    }

  Column(
    modifier = Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Text("Operations", style = mobileTitle1, color = mobileText)

    StatusCard(
      title = "Gateway",
      body = if (isConnected) "Running · $statusText" else "Stopped · $statusText",
      actionPrimary = if (isConnected) "Restart runtime" else "Start/reconnect",
      actionSecondary = "Reconnect",
      onPrimary = { viewModel.restartGatewayRuntime() },
      onSecondary = { viewModel.refreshGatewayConnection() },
    )

    StatusCard(
      title = "Diagnostics",
      body =
        "Port binding: ${diagnostics.portBinding}\n" +
          "Auth/session: ${diagnostics.authSession}\n" +
          "Node transport: ${if (nodeConnected) "Connected" else "Disconnected"}\n" +
          "Last restart reason: ${diagnostics.lastRestartReason}",
      actionPrimary = null,
      actionSecondary = null,
      onPrimary = null,
      onSecondary = null,
    )

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Channel connections", style = mobileHeadline, color = mobileText)
        if (channels.isEmpty()) {
          Text("No channel status yet. Connect to a gateway and wait for probe data.", style = mobileCallout, color = mobileTextSecondary)
        } else {
          channels.forEach { channel ->
            Text("${channel.label}: ${channel.state} · ${channel.detail}", style = mobileCaption1, color = mobileText)
          }
        }
      }
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Recent logs", style = mobileHeadline, color = mobileText)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          LogFilter.entries.forEach { option ->
            val active = option == filter
            Button(
              onClick = { filter = option },
              colors =
                ButtonDefaults.buttonColors(
                  containerColor = if (active) mobileAccent else mobileSurface,
                  contentColor = if (active) mobileSurface else mobileText,
                ),
            ) {
              Text(option.label, style = mobileCaption1)
            }
          }
        }
        OutlinedTextField(
          value = query,
          onValueChange = { query = it },
          placeholder = { Text("Filter by text/source", style = mobileCallout) },
          modifier = Modifier.fillMaxWidth(),
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text),
          textStyle = mobileBody.copy(fontFamily = FontFamily.Monospace),
          shape = RoundedCornerShape(12.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Button(
            onClick = { redactSensitive = !redactSensitive },
            colors = ButtonDefaults.buttonColors(containerColor = mobileAccentSoft, contentColor = mobileAccent),
          ) {
            Text(if (redactSensitive) "Redaction: On" else "Redaction: Off")
          }
        }
        val visibleLogs = filteredLogs
        if (visibleLogs.isEmpty()) {
          Text("No logs match the current filter.", style = mobileCallout, color = mobileTextSecondary)
        } else {
          visibleLogs.forEach { entry ->
            val safeMessage = if (redactSensitive) redactForUi(entry.message) else entry.message
            val line = "${fmt.format(Date(entry.timestampMs))} [${entry.level.uppercase(Locale.US)}] ${entry.source}: $safeMessage"
            Text(line, style = mobileCaption2.copy(fontFamily = FontFamily.Monospace), color = mobileText)
          }
        }
      }
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Recovery docs", style = mobileHeadline, color = mobileText)
        DocLink("Gateway troubleshooting", "https://docs.openclaw.ai/gateway/troubleshooting") { uriHandler.openUri("https://docs.openclaw.ai/gateway/troubleshooting") }
        DocLink("Gateway doctor", "https://docs.openclaw.ai/gateway/doctor") { uriHandler.openUri("https://docs.openclaw.ai/gateway/doctor") }
        DocLink("Channel troubleshooting", "https://docs.openclaw.ai/channels/troubleshooting") { uriHandler.openUri("https://docs.openclaw.ai/channels/troubleshooting") }
        DocLink("Node troubleshooting", "https://docs.openclaw.ai/nodes/troubleshooting") { uriHandler.openUri("https://docs.openclaw.ai/nodes/troubleshooting") }
      }
    }
  }
}

@Composable
private fun StatusCard(
  title: String,
  body: String,
  actionPrimary: String?,
  actionSecondary: String?,
  onPrimary: (() -> Unit)?,
  onSecondary: (() -> Unit)?,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileSurface,
    border = BorderStroke(1.dp, mobileBorder),
  ) {
    Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(title, style = mobileHeadline, color = mobileText)
      Text(body, style = mobileCallout, color = mobileTextSecondary)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (actionPrimary != null && onPrimary != null) {
          Button(onClick = onPrimary) {
            Text(actionPrimary)
          }
        }
        if (actionSecondary != null && onSecondary != null) {
          Button(
            onClick = onSecondary,
            colors = ButtonDefaults.buttonColors(containerColor = mobileAccentSoft, contentColor = mobileAccent),
          ) {
            Text(actionSecondary)
          }
        }
      }
    }
  }
}

@Composable
private fun DocLink(label: String, url: String, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    colors = ButtonDefaults.buttonColors(containerColor = mobileAccentSoft, contentColor = mobileAccent),
  ) {
    Text("$label: $url", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold))
  }
}

private fun redactForUi(value: String): String {
  val emailPattern = Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
  val tokenPattern = Regex("(?i)(token|password|secret|authorization)[=: ]+[^\\s,;]+")
  val phonePattern = Regex("\\+?[0-9][0-9\\- ]{7,}[0-9]")
  return value
    .replace(emailPattern, "[REDACTED_EMAIL]")
    .replace(tokenPattern) { match ->
      val key = match.value.substringBefore("=").substringBefore(":").trim().ifBlank { "secret" }
      "$key=[REDACTED]"
    }
    .replace(phonePattern, "[REDACTED_PHONE]")
}
