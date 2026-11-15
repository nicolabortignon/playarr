package me.tracklistme.playarr.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTests {
  @Test fun aHomeAddressGetsPlainHttpAndAnyOtherHttps() {
    assertEquals("http://192.168.1.103:4000", ServerAddress.url("192.168.1.103:4000"))
    assertEquals("http://nas.local:4000", ServerAddress.url(" nas.local:4000/ "))
    assertEquals("https://music.example.com/playarr", ServerAddress.url("music.example.com/playarr/?x=1#y"))
  }

  @Test fun refusesPlainHttpAwayFromHomeAndWhatIsntAnAddress() {
    assertEquals(ServerAddress.Problem.NeedsHttps, assertThrows(ServerAddress.Rejected::class.java) { ServerAddress.url("http://example.com") }.problem)
    assertEquals(ServerAddress.Problem.Empty, assertThrows(ServerAddress.Rejected::class.java) { ServerAddress.url("  ") }.problem)
    assertEquals(ServerAddress.Problem.Invalid, assertThrows(ServerAddress.Rejected::class.java) { ServerAddress.url("ftp://nas") }.problem)
  }

  @Test fun knowsTheHomeNetworksAddresses() {
    listOf("localhost", "nas", "nas.local", "10.0.0.2", "172.16.0.1", "172.31.255.255", "192.168.1.42", "169.254.1.1", "127.0.0.1", "[::1]", "fe80::1", "fd00::1")
      .forEach { assertTrue(it, ServerAddress.isLocal(it)) }
    listOf("example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1").forEach { assertFalse(it, ServerAddress.isLocal(it)) }
  }
}
