// Playarr on the TV (plan 9). Modules: api (models, client, servers, tokens), player (Media3, the queue, levels, plays)
// and app (the screens). app depends on player, and both on api.
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
include(":api", ":player", ":app")
