package me.tracklistme.playarr.tv.ambilight

import android.content.Context
import androidx.core.content.edit
import java.security.SecureRandom
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import me.tracklistme.playarr.api.SecretStore

/**
 * Settings → Ambilight on this TV: the switch (off by default), where JointSpace answered, its certificate's pin, this
 * app's pairing id, and the credentials from pairing (in the Keystore, as tokens are).
 */
class AmbilightStore(context: Context, private val secrets: SecretStore) {
  private val prefs = context.getSharedPreferences("ambilight", Context.MODE_PRIVATE)
  private val enabledState = MutableStateFlow(prefs.getBoolean(ENABLED, false))
  val enabled: StateFlow<Boolean> = enabledState.asStateFlow()

  fun setEnabled(on: Boolean) {
    prefs.edit { putBoolean(ENABLED, on) }
    enabledState.value = on
  }

  var base: String?
    get() = prefs.getString(BASE, null)
    set(value) = prefs.edit { putString(BASE, value) }

  fun certificate(): String? = prefs.getString(CERTIFICATE, null)
  fun pinCertificate(fingerprint: String) = prefs.edit { putString(CERTIFICATE, fingerprint) }

  /** This app's id among the TV's paired devices, made once. */
  fun deviceId(): String = prefs.getString(DEVICE_ID, null) ?: ByteArray(8).also(SecureRandom()::nextBytes)
    .joinToString("") { "%02x".format(it) }
    .also { prefs.edit { putString(DEVICE_ID, it) } }

  var credentials: JointSpace.Credentials?
    get() = secrets.get(CREDENTIALS)?.split('\n', limit = 2)?.takeIf { it.size == 2 }?.let { JointSpace.Credentials(it[0], it[1]) }
    set(value) = secrets.set(CREDENTIALS, value?.let { "${it.user}\n${it.password}" })

  /** Pairing again: the TV found afresh, its certificate seen afresh, new credentials. */
  fun forget() {
    prefs.edit { remove(BASE); remove(CERTIFICATE) }
    credentials = null
  }

  private companion object {
    const val ENABLED = "enabled"
    const val BASE = "base"
    const val CERTIFICATE = "certificate"
    const val DEVICE_ID = "deviceId"
    const val CREDENTIALS = "ambilight.credentials"
  }
}
