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

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
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
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.foundation)
  implementation(libs.tv.material)
  testImplementation(libs.junit)
}
