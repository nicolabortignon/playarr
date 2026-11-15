package me.tracklistme.playarr.api

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Where tokens are kept, by key (the iOS app's SecretStore). */
public interface SecretStore {
  public fun get(key: String): String?
  public fun set(key: String, value: String?)
}

/** In memory, for tests and previews. */
public class InMemorySecretStore : SecretStore {
  private val values = mutableMapOf<String, String>()
  override fun get(key: String): String? = synchronized(values) { values[key] }
  override fun set(key: String, value: String?): Unit = synchronized(values) { if (value == null) values.remove(key) else values[key] = value }
}

/**
 * Tokens encrypted with an AES key that never leaves the Android Keystore (AES-GCM), the ciphertext kept in the app's
 * own preferences, which aren't backed up (allowBackup is off). A token that can't be decrypted (the key was lost, as
 * after clearing the app's data) reads as missing: that account signs in again.
 */
public class KeystoreSecretStore(context: Context) : SecretStore {
  private val prefs = context.getSharedPreferences("playarr.secrets", Context.MODE_PRIVATE)

  override fun get(key: String): String? {
    val stored = prefs.getString(key, null) ?: return null
    return try {
      val bytes = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
      String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }

  override fun set(key: String, value: String?) {
    if (value == null) {
      prefs.edit().remove(key).apply()
      return
    }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    prefs.edit().putString(key, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "playarr.tokens"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
