package me.tracklistme.playarr.tv.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import me.tracklistme.playarr.tv.playarr

/**
 * The TV's installer answering an update (GitHubUpdates.commit): its confirmation screen to show, or how it ended. Not
 * exported: only the installer, through the PendingIntent the session was given, reaches it.
 */
class InstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val updates = context.playarr.updates as? GitHubUpdates ?: return
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      PackageInstaller.STATUS_SUCCESS -> updates.installed()
      else -> updates.failed(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
  }
}
