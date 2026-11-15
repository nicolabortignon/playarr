package me.tracklistme.playarr.api

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.util.concurrent.Executors
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Finds Playarr servers on the home network: Bonjour's `_playarr._tcp`, through Android's NsdManager. The flow gives
 * the servers found so far, one per server id, every time the list changes, and stops looking when collection stops.
 */
public class ServerBrowser(context: Context) {
  private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager

  public fun servers(): Flow<List<DiscoveredServer>> = callbackFlow {
    var found = emptyList<DiscoveredServer>()
    val names = mutableMapOf<String, String>() // service name → server id, to drop it when it goes
    // Resolving one service at a time: older NsdManagers refuse a second resolve while one is under way.
    val resolving = Executors.newSingleThreadExecutor()
    trySend(found)

    fun add(info: NsdServiceInfo) {
      val host = hostOf(info) ?: return
      val txt = info.attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8) ?: "" }
      val server = DiscoveredServer.from(txt, host, info.port) ?: return
      synchronized(names) {
        names[info.serviceName] = server.id
        found = DiscoveredServer.merge(found, server)
        trySend(found)
      }
    }

    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { close() }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onServiceFound(info: NsdServiceInfo) {
        resolving.execute {
          val done = java.util.concurrent.CountDownLatch(1)
          @Suppress("DEPRECATION")
          nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = done.countDown()
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
              add(serviceInfo)
              done.countDown()
            }
          })
          done.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }
      }

      override fun onServiceLost(info: NsdServiceInfo) {
        synchronized(names) {
          val id = names.remove(info.serviceName) ?: return
          found = found.filter { it.id != id }
          trySend(found)
        }
      }
    }
    nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    awaitClose {
      runCatching { nsd.stopServiceDiscovery(listener) }
      resolving.shutdownNow()
    }
  }

  private fun hostOf(info: NsdServiceInfo): String? {
    val addresses = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(@Suppress("DEPRECATION") info.host)
    // IPv4 first: a link-local IPv6 address needs its interface, which a URL carries badly.
    return (addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull())?.hostAddress
  }

  private companion object {
    const val SERVICE_TYPE = "_playarr._tcp."
  }
}
