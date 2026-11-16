package me.tracklistme.playarr.tv.ambilight

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DigestTests {
  @Test fun answersRfc2617sExample() {
    val challenge = Digest.parse("""Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"""")!!
    assertEquals("auth", challenge.qop)
    val header = Digest.header(challenge, "GET", "/dir/index.html", "Mufasa", "Circle Of Life", "0a4f113b", 1)
    assertTrue(header, header.contains("""response="6629fae49393a05397450978507c4ef1""""))
    assertTrue(header.contains("nc=00000001"))
    assertTrue(header.contains("""opaque="5ccc069c403ebaf9f0171e9517f40e41""""))
  }

  @Test fun refusesWhatItCannotAnswer() {
    assertNull(Digest.parse("""Basic realm="x""""))
    assertNull(Digest.parse("""Digest realm="x", nonce="n", algorithm=SHA-256"""))
    assertNull(Digest.parse("""Digest realm="x", nonce="n", qop="auth-int""""))
  }

  @Test fun withoutQopTheOlderFormula() {
    val c = Digest.parse("""Digest realm="XTV", nonce="abc"""")!!
    val header = Digest.header(c, "POST", "/6/pair/grant", "id", "key", "cn", 1)
    assertTrue(!header.contains("qop="))
  }
}
