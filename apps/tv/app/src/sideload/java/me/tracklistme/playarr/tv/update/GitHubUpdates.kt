package me.tracklistme.playarr.tv.update

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit
import androidx.core.net.toUri
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import me.tracklistme.playarr.tv.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * The sideload flavor updating itself from GitHub releases (plan 9 §7). Each time the app comes to the front it asks
 * GitHub, at most once a day, for a `tv-v*` release newer than itself (TvReleases); Settings → About offers it, and
 * the Settings rail item carries a dot. Installing downloads the APK (checked against GitHub's size and SHA-256, then
 * read: this app's package and a higher version code) and hands it to the TV's PackageInstaller, which asks to
 * confirm. The TV has to allow Playarr to install unknown apps once; the app opens that setting, and carries on when
 * the owner comes back with it allowed. Android checks that the APK is signed with the same key as the app installed.
 */
class GitHubUpdates(
  private val context: Context,
  http: OkHttpClient,
  repo: String = BuildConfig.UPDATES_REPO,
  private val installed: String = BuildConfig.VERSION_NAME,
) : SelfUpdate {
  // Not through the HTTP cache: an APK would push the covers out of it.
  private val http = http.newBuilder().cache(null).build()
  private val releases = TvReleases(this.http, repo)
  private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
  private val dir = File(context.cacheDir, "updates")
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val stateFlow = MutableStateFlow(saved()?.let(::shown) ?: UpdateState.Unknown)
  override val state: StateFlow<UpdateState> = stateFlow.asStateFlow()
  private var job: Job? = null

  override fun resumed() {
    val now = stateFlow.value
    if (now is UpdateState.Allow && canInstall()) return install()
    if (now is UpdateState.Installing && job?.isActive != true) {
      // Back from the installer without it finishing (Back on its screen sends no answer on some TVs).
      stateFlow.value = UpdateState.Available(now.release)
    }
    if (System.currentTimeMillis() - prefs.getLong(CHECKED_AT, 0) >= DAY_MS) check()
  }

  @Synchronized
  override fun check() {
    val before = stateFlow.value
    if (job?.isActive == true || before is UpdateState.Installing) return
    stateFlow.value = UpdateState.Checking
    job = scope.launch {
      try {
        val latest = releases.latest()
        prefs.edit { putLong(CHECKED_AT, System.currentTimeMillis()) }
        save(latest)
        if (latest?.isNewerThan(installed) != true) dir.deleteRecursively()
        stateFlow.value = shown(latest)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        stateFlow.value = UpdateState.Failed("Couldn’t ask GitHub for updates: ${e.message ?: e.javaClass.simpleName}.", before.release)
      }
    }
  }

  @Synchronized
  override fun install() {
    val release = stateFlow.value.release ?: return
    if (job?.isActive == true) return
    if (!canInstall()) {
      stateFlow.value = UpdateState.Allow(release)
      openInstallSetting()
      return
    }
    stateFlow.value = UpdateState.Downloading(release, 0)
    job = scope.launch {
      var latest = release
      try {
        // Asked afresh: what was found may be a day old, and a release can gain a newer one or have its APK replaced
        // since (its SHA-256 then differs from the one kept).
        val found = releases.latest()
        if (found?.isNewerThan(installed) != true) return@launch upToDate(found)
        latest = found
        save(latest)
        stateFlow.value = UpdateState.Downloading(latest, 0)
        val apk = download(latest)
        verify(apk)
        stateFlow.value = UpdateState.Installing(latest)
        commit(apk)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        stateFlow.value = UpdateState.Failed(e.message ?: "The update didn’t install (${e.javaClass.simpleName}).", latest)
      }
    }
  }

  // The installer's answers (InstallReceiver).

  fun installed() = upToDate(saved())

  private fun upToDate(latest: TvReleases.Release?) {
    dir.deleteRecursively()
    save(latest)
    stateFlow.value = UpdateState.UpToDate(latest)
  }

  /** What there is to say about the newest release: an offer when it's newer than this app. */
  private fun shown(latest: TvReleases.Release?): UpdateState =
    if (latest != null && latest.isNewerThan(installed)) UpdateState.Available(latest) else UpdateState.UpToDate(latest)

  fun failed(status: Int, message: String?) {
    val release = stateFlow.value.release ?: saved()?.takeIf { it.isNewerThan(installed) } ?: return
    stateFlow.value = when (status) {
      PackageInstaller.STATUS_FAILURE_ABORTED -> UpdateState.Available(release)
      PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
        UpdateState.Failed("The update is signed with another key than this Playarr (a development build?). Uninstall it, then install the release.", release)
      PackageInstaller.STATUS_FAILURE_STORAGE -> UpdateState.Failed("The TV doesn’t have room for the update.", release)
      PackageInstaller.STATUS_FAILURE_BLOCKED -> UpdateState.Failed("The TV refused to install the update${message?.let { " ($it)" }.orEmpty()}.", release)
      else -> UpdateState.Failed("The TV couldn’t install the update${message?.let { " ($it)" }.orEmpty()}.", release)
    }
  }

  // Downloading and installing.

  private fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

  /** Settings → Unknown sources for this app, where the TV has that screen; Settings → About says where otherwise. */
  private fun openInstallSetting() {
    val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
    try {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
    }
  }

  private fun download(release: TvReleases.Release): File {
    dir.mkdirs()
    val apk = File(dir, "playarr-tv-${release.version}.apk")
    if (apk.length() == release.size && (release.sha256 == null || sha256(apk) == release.sha256)) return apk
    dir.listFiles()?.forEach { it.delete() }
    val partial = File(dir, "${apk.name}.part")
    val digest = MessageDigest.getInstance("SHA-256")
    var read = 0L
    http.newCall(Request.Builder().url(release.apk).build()).execute().use { response ->
      if (!response.isSuccessful) throw IOException("GitHub answered ${response.code} for the update. Try again later.")
      response.body.byteStream().use { input ->
        partial.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          var shown = 0
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            output.write(buffer, 0, n)
            digest.update(buffer, 0, n)
            read += n
            val percent = if (release.size > 0) (read * 100 / release.size).toInt().coerceIn(0, 100) else 0
            if (percent != shown) {
              shown = percent
              stateFlow.value = UpdateState.Downloading(release, percent)
            }
          }
        }
      }
    }
    if (read != release.size) throw IOException("The download stopped at $read of ${release.size} bytes. Try again.")
    if (release.sha256 != null && digest.digest().hex() != release.sha256) {
      partial.delete()
      throw IOException("The download doesn’t match the release on GitHub (its SHA-256 differs), so it wasn’t installed.")
    }
    if (!partial.renameTo(apk)) throw IOException("The download couldn’t be kept.")
    return apk
  }

  /** The APK is this app, newer than the one installed: anything else would only fail in the installer, less clearly. */
  private fun verify(apk: File) {
    val pm = context.packageManager
    val found = archiveInfo(pm, apk) ?: run {
      apk.delete()
      throw IOException("The download isn’t an app the TV can read.")
    }
    if (found.packageName != context.packageName) throw IOException("The download is another app (${found.packageName}).")
    val current = pm.getPackageInfo(context.packageName, 0).longVersionCode
    if (found.longVersionCode <= current) {
      throw IOException("The download is build ${found.longVersionCode} (${found.versionName}), not newer than this Playarr’s build $current.")
    }
  }

  private fun commit(apk: File) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      setSize(apk.length())
      setInstallReason(PackageManager.INSTALL_REASON_USER)
      // Once Playarr installed itself, Android 12 and later may update it without asking again.
      if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val id = installer.createSession(params)
    try {
      installer.openSession(id).use { session ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          apk.inputStream().use { it.copyTo(output) }
          session.fsync(output)
        }
        // Mutable: the installer adds its status to the intent. Explicit, to InstallReceiver, which isn't exported.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val answer = PendingIntent.getBroadcast(context, id, Intent(context, InstallReceiver::class.java), flags)
        session.commit(answer.intentSender)
      }
    } catch (e: Exception) {
      installer.abandonSession(id)
      throw e
    }
  }

  // The newest release found, kept so the offer (or "Latest release …") outlives the app.

  private fun saved(): TvReleases.Release? {
    val version = prefs.getString(VERSION, null) ?: return null
    return TvReleases.Release(
      version = version,
      apk = prefs.getString(APK, null) ?: return null,
      size = prefs.getLong(SIZE, -1).takeIf { it > 0 } ?: return null,
      sha256 = prefs.getString(SHA256, null),
      notes = prefs.getString(NOTES, null).orEmpty(),
      published = prefs.getLong(PUBLISHED, 0).takeIf { it > 0 },
    )
  }

  private fun save(release: TvReleases.Release?) = prefs.edit {
    if (release == null) {
      listOf(VERSION, APK, SIZE, SHA256, NOTES, PUBLISHED).forEach(::remove)
    } else {
      putString(VERSION, release.version)
      putString(APK, release.apk)
      putLong(SIZE, release.size)
      putString(SHA256, release.sha256)
      putString(NOTES, release.notes)
      putLong(PUBLISHED, release.published ?: 0)
    }
  }

  private companion object {
    const val DAY_MS = 24L * 60 * 60 * 1000
    const val CHECKED_AT = "checkedAt"
    const val VERSION = "version"
    const val APK = "apk"
    const val SIZE = "size"
    const val SHA256 = "sha256"
    const val NOTES = "notes"
    const val PUBLISHED = "published"

    fun sha256(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          digest.update(buffer, 0, n)
        }
      }
      return digest.digest().hex()
    }

    fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    fun archiveInfo(pm: PackageManager, apk: File): PackageInfo? =
      if (Build.VERSION.SDK_INT >= 33) {
        pm.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageArchiveInfo(apk.path, 0)
      }
  }
}
