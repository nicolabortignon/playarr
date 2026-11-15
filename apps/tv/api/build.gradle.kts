plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "me.tracklistme.playarr.api"
  compileSdk = 37
  defaultConfig { minSdk = 28 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
  explicitApi()
  compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

// The contract tests decode the server's recorded answers, kept with the iOS app's tests (RECORD_FIXTURES=1 rewrites them).
tasks.withType<Test>().configureEach {
  systemProperty("fixtures", rootProject.file("../ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures").absolutePath)
}

dependencies {
  api(libs.kotlinx.serialization.json)
  api(libs.kotlinx.coroutines.android)
  api(libs.okhttp)
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(libs.okhttp.mockwebserver)
}
