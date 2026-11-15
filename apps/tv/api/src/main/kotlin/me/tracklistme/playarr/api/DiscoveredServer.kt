package me.tracklistme.playarr.api

/** A Playarr server found on the home network by Bonjour (`_playarr._tcp`): the iOS app's DiscoveredServer. */
public data class DiscoveredServer(
  /** The server's UUID (TXT `id`), the same as GET /api/server's. */
  val id: String,
  val name: String,
  val version: String,
  val baseUrl: String,
) {
  public companion object {
    /** From the service's TXT record (`id`, `v`, `name`, `path`) and resolved address; null without an id. */
    public fun from(txt: Map<String, String>, host: String, port: Int): DiscoveredServer? {
      val id = txt["id"]?.takeIf { it.isNotEmpty() } ?: return null
      val bracketed = if (host.contains(":")) "[${host.replace("%", "%25")}]" else host
      val path = (txt["path"] ?: "/").trimEnd('/')
      return DiscoveredServer(id, txt["name"]?.takeIf { it.isNotEmpty() } ?: "Playarr", txt["v"] ?: "", "http://$bracketed:$port$path")
    }

    /** `servers` with `server` added, one entry per server id (the newest address wins), sorted by name. */
    public fun merge(servers: List<DiscoveredServer>, server: DiscoveredServer): List<DiscoveredServer> =
      (servers.filter { it.id != server.id } + server).sortedBy { it.name.lowercase() }
  }
}
