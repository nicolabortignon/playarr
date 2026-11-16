package me.tracklistme.playarr.tv.update

import java.io.IOException
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TvReleasesTests {
  private val server = MockWebServer()

  @Before fun start() = server.start()
  @After fun stop() = server.close()

  private fun releases() = TvReleases(OkHttpClient(), server.url("/repos/o/playarr").toString().trimEnd('/'))

  private fun tags(vararg names: String) =
    names.joinToString(",", "[", "]") { """{"ref":"refs/tags/$it","object":{"sha":"abc","type":"commit"}}""" }

  private fun release(version: String, digest: String? = "sha256:${"ab".repeat(32)}", draft: Boolean = false, prerelease: Boolean = false, asset: String = "playarr-tv-$version.apk") = """
    {"tag_name":"tv-v$version","draft":$draft,"prerelease":$prerelease,"body":"What's new in $version","published_at":"2026-11-14T09:30:00Z",
     "assets":[
       {"name":"other.txt","browser_download_url":"https://example/other.txt","size":3,"state":"uploaded"},
       {"name":"$asset","browser_download_url":"https://github.com/o/playarr/releases/download/tv-v$version/$asset",
        "size":12345,"state":"uploaded"${digest?.let { ""","digest":"$it"""" } ?: ""}}
     ]}
  """.trimIndent()

  private fun ok(body: String) = MockResponse.Builder().body(body).build()
  private fun code(code: Int) = MockResponse.Builder().code(code).body("""{"message":"x"}""").build()

  @Test fun findsTheHighestTagNewerThanThisApp() {
    server.enqueue(ok(tags("tv-v1.0.0", "tv-v1.10.0", "tv-v1.9.2", "tv-vnope")))
    server.enqueue(ok(release("1.10.0")))
    val found = releases().newest("1.0.0")!!
    assertEquals("1.10.0", found.version)
    assertEquals("https://github.com/o/playarr/releases/download/tv-v1.10.0/playarr-tv-1.10.0.apk", found.apk)
    assertEquals(12345L, found.size)
    assertEquals("ab".repeat(32), found.sha256)
    assertEquals("What's new in 1.10.0", found.notes)
    assertEquals(1_794_648_600_000L, found.published)

    val asked = server.takeRequest()
    assertEquals("/repos/o/playarr/git/matching-refs/tags/tv-v", asked.url.encodedPath)
    assertEquals("application/vnd.github+json", asked.headers["Accept"])
    assertEquals("/repos/o/playarr/releases/tags/tv-v1.10.0", server.takeRequest().url.encodedPath)
  }

  @Test fun upToDateStillReadsTheNewestRelease() {
    server.enqueue(ok(tags("tv-v0.9.0", "tv-v1.0.0")))
    server.enqueue(ok(release("1.0.0")))
    val latest = releases().latest()!!
    assertEquals("1.0.0", latest.version)
    assertEquals(1_794_648_600_000L, latest.published)
    assertEquals(false, latest.isNewerThan("1.0.0"))
    assertEquals(true, latest.isNewerThan("0.9.9"))

    server.enqueue(ok(tags("tv-v0.9.0", "tv-v1.0.0")))
    server.enqueue(ok(release("1.0.0")))
    assertNull(releases().newest("1.0.0"))
  }

  @Test fun noTagsAtAll() {
    server.enqueue(code(404))
    assertNull(releases().newest("1.0.0"))
  }

  @Test fun aTagWhoseReleaseIsntReadyGivesWayToTheOneBelow() {
    server.enqueue(ok(tags("tv-v1.1.0", "tv-v1.2.0")))
    server.enqueue(code(404)) // tv-v1.2.0: CI still building
    server.enqueue(ok(release("1.1.0")))
    assertEquals("1.1.0", releases().newest("1.0.0")!!.version)
  }

  @Test fun aReleaseWithoutItsApkYetIsSkipped() {
    server.enqueue(ok(tags("tv-v1.1.0", "tv-v1.2.0")))
    server.enqueue(ok(release("1.2.0", asset = "playarr-tv-1.2.0.aab")))
    server.enqueue(ok(release("1.1.0")))
    assertEquals("1.1.0", releases().newest("1.0.0")!!.version)
  }

  @Test fun draftsAndPreReleasesAreSkipped() {
    server.enqueue(ok(tags("tv-v1.1.0", "tv-v1.2.0", "tv-v1.3.0")))
    server.enqueue(ok(release("1.3.0", draft = true)))
    server.enqueue(ok(release("1.2.0", prerelease = true)))
    server.enqueue(ok(release("1.1.0")))
    assertEquals("1.1.0", releases().newest("1.0.0")!!.version)
  }

  @Test fun triesThreeTagsAtMost() {
    server.enqueue(ok(tags("tv-v1.1.0", "tv-v1.2.0", "tv-v1.3.0", "tv-v1.4.0")))
    repeat(3) { server.enqueue(code(404)) }
    assertNull(releases().newest("1.0.0"))
    assertEquals(4, server.requestCount)
  }

  @Test fun aReleaseWithoutADigestStillCounts() {
    server.enqueue(ok(tags("tv-v1.1.0")))
    server.enqueue(ok(release("1.1.0", digest = null)))
    assertNull(releases().newest("1.0.0")!!.sha256)
  }

  @Test fun anOddDigestIsIgnored() {
    server.enqueue(ok(tags("tv-v1.1.0")))
    server.enqueue(ok(release("1.1.0", digest = "md5:abc")))
    assertNull(releases().newest("1.0.0")!!.sha256)
  }

  @Test fun gitHubSayingWaitIsAnError() {
    server.enqueue(code(403))
    val error = assertThrows(IOException::class.java) { releases().newest("1.0.0") }
    assertTrue(error.message!!.contains("wait"))
  }

  @Test fun versionsCompareNumberByNumber() {
    assertTrue(Version.parse("1.10.0")!! > Version.parse("1.9.9")!!)
    assertTrue(Version.parse("1.0.1")!! > Version.parse("1.0")!!)
    assertEquals(0, Version.parse("1.0")!!.compareTo(Version.parse("1.0.0")!!))
    assertNull(Version.parse("1.0-beta"))
    assertNull(Version.parse(""))
    assertEquals("1.2.3", Version.parse(" 1.2.3 ").toString())
  }
}
