// Playarr on the TV (plan 9). Modules: api (models, client, servers, tokens) and app (the screens); player comes with
// step 4. app depends on api.
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "playarr-tv"
include(":api", ":app")
