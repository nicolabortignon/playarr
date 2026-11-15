package me.tracklistme.playarr.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerStoreTests {
  private class Values : KeyValues {
    val map = mutableMapOf<String, String>()
    override fun get(key: String) = map[key]
    override fun set(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
  }

  private val server = ServerInfo(id = "s1", name = "Playarr", version = "0.6.607", minAppVersion = "1.0.0", setup = false)
  private fun account(id: Int, name: String) = Account(id = id, username = name.lowercase(), name = name, role = AccountRole.Member, canRequest = true, sources = null, hasPassword = true)

  @Test fun keepsSignInsAndWhoListensAcrossLaunches() {
    val values = Values()
    val secrets = InMemorySecretStore()
    val store = ServerStore(values, secrets)
    store.signedIn(server, "http://nas.local:4000", account(1, "Nicola"), "t1")
    store.signedIn(server, "http://nas.local:4000", account(2, "Alex"), "t2")
    assertEquals(Listening("s1", 2), store.current.value.listening)
    assertEquals(listOf("Alex", "Nicola"), store.current.value.server!!.accounts.map { it.name })

    val again = ServerStore(values, secrets)
    assertEquals("Alex", again.current.value.account!!.name)
    assertEquals("t1", again.token("s1", 1))
    again.switchTo("s1", 1)
    assertEquals("Nicola", again.current.value.account!!.name)
  }

  @Test fun signingOutForgetsTheTokenAndHandsOverToAnotherAccount() {
    val store = ServerStore(Values(), InMemorySecretStore())
    store.signedIn(server, "http://nas.local:4000", account(1, "Nicola"), "t1")
    store.signedIn(server, "http://nas.local:4000", account(2, "Alex"), "t2")
    store.signedOut("s1", 2)
    assertNull(store.token("s1", 2))
    assertEquals(Listening("s1", 1), store.current.value.listening)
    store.signedOut("s1", 1)
    assertNull(store.current.value.listening)
  }

  @Test fun findsServersByTheirTxtRecord() {
    val found = DiscoveredServer.from(mapOf("id" to "s1", "name" to "", "v" to "0.6.607", "path" to "/playarr/"), "192.168.1.103", 4000)!!
    assertEquals(DiscoveredServer("s1", "Playarr", "0.6.607", "http://192.168.1.103:4000/playarr"), found)
    assertNull(DiscoveredServer.from(mapOf("name" to "x"), "h", 1))
    assertEquals("http://[fe80::1%25en0]:4000", DiscoveredServer.from(mapOf("id" to "s1"), "fe80::1%en0", 4000)!!.baseUrl)
  }
}
