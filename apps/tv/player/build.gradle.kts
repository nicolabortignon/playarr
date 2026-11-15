plugins {
  alias(libs.plugins.android.library)
}

android {
  namespace = "me.tracklistme.playarr.player"
  compileSdk = 37
  defaultConfig { minSdk = 28 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  testOptions {
    unitTests.isReturnDefaultValues = true
    // Robolectric, for Media3's extractors in the gapless tests.
    unitTests.isIncludeAndroidResources = true
  }
}

kotlin {
  explicitApi()
  compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
  api(project(":api"))
  api(libs.media3.exoplayer)
  api(libs.media3.session)
  implementation(libs.media3.datasource.okhttp)
  testImplementation(libs.junit)
  testImplementation(libs.media3.test.utils)
  testImplementation(libs.robolectric)
}
