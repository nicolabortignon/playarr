plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
}

// Version code: the commit count, as the iOS app's build number; the name is kept by hand.
val commitCount: Int = providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
  .standardOutput.asText.get().trim().toIntOrNull() ?: 1

android {
  namespace = "me.tracklistme.playarr.tv"
  compileSdk = 37

  defaultConfig {
    applicationId = "me.tracklistme.playarr.tv"
    // Android TV 9, what the owner's Philips shipped with.
    minSdk = 28
    targetSdk = 37
    versionCode = commitCount
    versionName = "1.0.0"
  }

  // Where the app comes from (plan 9 §7): GitHub releases, updating itself from them (Settings → About), or Google
  // Play, which updates it and doesn't allow an app to install packages.
  flavorDimensions += "store"
  productFlavors {
    create("sideload") {
      dimension = "store"
      // Where it looks for its updates: the repository's GitHub API address (-PupdatesRepo=… points a test build at a
      // stand-in, as docs/tv/release.md does on the emulator).
      val repo = providers.gradleProperty("updatesRepo").getOrElse("https://api.github.com/repos/nicolabortignon/playarr")
      buildConfigField("String", "UPDATES_REPO", "\"$repo\"")
    }
    create("play") { dimension = "store" }
  }

  // The upload key, from the environment (CI's secrets, or the owner's Mac: docs/tv/release.md). Without it a release
  // build is left unsigned.
  // A secret CI doesn't have arrives as an empty string, so blank counts as unset.
  fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }
  val keystore = env("PLAYARR_TV_KEYSTORE")
  signingConfigs {
    if (keystore != null) create("upload") {
      storeFile = file(keystore)
      storePassword = env("PLAYARR_TV_KEYSTORE_PASSWORD")
      keyAlias = env("PLAYARR_TV_KEY_ALIAS") ?: "upload"
      keyPassword = env("PLAYARR_TV_KEY_PASSWORD") ?: env("PLAYARR_TV_KEYSTORE_PASSWORD")
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      if (keystore != null) signingConfig = signingConfigs.getByName("upload")
    }
  }

  buildFeatures {
    compose = true
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  lint {
    warningsAsErrors = false
    abortOnError = true
  }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
  implementation(project(":player"))
  implementation(libs.androidx.core.ktx)
  implementation(libs.lifecycle.viewmodel.compose)
  implementation(libs.lifecycle.runtime.compose)
  implementation(libs.zxing.core)
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.foundation)
  implementation(libs.compose.material.icons)
  implementation(libs.tv.material)
  testImplementation(libs.junit)
  testImplementation(libs.okhttp.mockwebserver)
}
