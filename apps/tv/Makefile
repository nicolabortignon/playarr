# Playarr on the TV (plan 9): every entry point. The root package.json's `pnpm tv:*` scripts call these targets.
#
#   make bootstrap   download the pinned JDK and Android SDK into .tools/ (checksums checked), accept the SDK's licenses
#   make build       a debug APK (app/build/outputs/apk/debug/)
#   make test        the unit tests (the contract tests among them), Android Lint of both flavors, and the scripts' tests
#   make contracts   only the contract tests: the server's recorded answers decode into the generated models
#   make models      regenerate the api module's Kotlin models from the shared TypeScript types (models-check: up to date?)
#   make gradle ARGS=":api:test --tests '*Contract*'"  any Gradle task, with the pinned JDK, SDK and proxy
#   make install     build, then install and start it on the TV over adb (TV_ADDRESS=192.168.1.42 by default; the TV
#                    needs Developer options → USB debugging / network debugging on, and accepts the Mac once)
#   make logs        the app's log from the TV
#   make meminfo     the app's memory on the TV (dumpsys meminfo), the number plan 9 keeps under 200 MB
#   make device-info the TV's Android version, RAM, heap limit and low-RAM flag (plan 9's table)
#   make screens     a screenshot of what the TV shows, in screenshots/tv/ at the repo root
#   make emulator    boot an Android TV emulator (2 GB, Android 16) without a window; then TV=emulator-5554 make install …
#   make demo        a local Playarr with a made-up library for the emulator, at http://10.0.2.2:4620 there, with a
#                    pinned ffmpeg in .tools/ for the streams it plays
#                    (scripts/demo-server.mjs; `node scripts/demo-server.mjs approve CODE` signs a TV in as its owner)
#   make join-test   the DJ-transition join spike on the TV or emulator, checked sample by sample
#   make fake-tv     a stand-in for the TV's JointSpace (the Ambilight) that the emulator reaches
#   make release     the signed sideload APK and Play bundle in build/release/ (docs/tv/release.md)
#   make upload-key  make the upload key that signs releases (once, kept outside the repo; named in the repo's .env)
#   make ci-secrets  give GitHub the upload key (and the Play service account) for the tv-v* tag's release job
#   make play-check  is the Play service account accepted? (play-upload sends build/release's bundle to TRACK)
#   make fake-releases  a stand-in for GitHub's releases, for trying the self-update on the emulator
#   make store-images   draw the Play pictures (store/en-US/images/) and the launcher banner (scripts/store-images.swift)
#   make store-screens  the Play listing's TV screenshots from the emulator and make demo (store/en-US/images/tv-screenshots/)
#   make clean       remove build output
#
# Nothing comes from Homebrew (not writable on the owner's Mac): the JDK, the SDK and Gradle (through the checked-in
# wrapper) are pinned here. Behind an HTTP proxy (HTTPS_PROXY set), Java is told about it, as it doesn't read the variable.
# macOS ships GNU Make 3.81: no .ONESHELL or .SHELLFLAGS, so a line with several commands starts with `set -e`.

SHELL := /bin/bash

JDK_VERSION := 21.0.13+9
JDK_FILE := OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.13_9.tar.gz
JDK_URL := https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/$(JDK_FILE)
JDK_SHA256 := bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a

# Android's command-line tools (sdkmanager, avdmanager); sdkmanager checks what it installs itself.
CMDLINE_FILE := commandlinetools-mac_arm64-16111833_latest.zip
CMDLINE_SHA1 := ad03dc49bfacfd52c110b14104ea548b8a07e830
SDK_PACKAGES := platform-tools platforms;android-37.0 build-tools;37.0.0

# ffmpeg for the demo server's encoded streams (levelled.aac, what the TV plays): a static macOS build.
FFMPEG_URL := https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
FFMPEG_SHA256 := c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924

TOOLS := $(CURDIR)/.tools
# On CI the runner's own JDK and SDK (JAVA_HOME, ANDROID_HOME) are used.
export JAVA_HOME ?= $(TOOLS)/jdk-$(JDK_VERSION)/Contents/Home
export ANDROID_HOME ?= $(TOOLS)/android-sdk
SDKMANAGER := $(ANDROID_HOME)/cmdline-tools/latest/bin/sdkmanager
ADB := $(ANDROID_HOME)/platform-tools/adb

# HTTPS_PROXY=http://host:port → Java's own proxy properties.
proxy := $(patsubst http://%,%,$(patsubst https://%,%,$(or $(HTTPS_PROXY),$(https_proxy))))
proxy := $(patsubst %/,%,$(proxy))
ifneq ($(proxy),)
  proxy_host := $(word 1,$(subst :, ,$(proxy)))
  proxy_port := $(word 2,$(subst :, ,$(proxy)))
  export JAVA_TOOL_OPTIONS := -Dhttp.proxyHost=$(proxy_host) -Dhttp.proxyPort=$(proxy_port) -Dhttps.proxyHost=$(proxy_host) -Dhttps.proxyPort=$(proxy_port) -Dhttp.nonProxyHosts=localhost|127.0.0.1
  SDK_PROXY := --proxy=http --proxy_host=$(proxy_host) --proxy_port=$(proxy_port)
endif

GRADLE := ./gradlew --console=plain
TV_ADDRESS ?= 192.168.1.42
# The device adb talks to: the owner's TV over the network, or TV=emulator-5554 for the emulator.
TV ?= $(TV_ADDRESS):5555
EMULATOR_IMAGE := system-images;android-36;android-tv;arm64-v8a
export ANDROID_AVD_HOME := $(TOOLS)/avd
APP_ID := me.tracklistme.playarr.tv
APK := app/build/outputs/apk/sideload/debug/app-sideload-debug.apk
SCREENS_ROOT := ../../screenshots/tv

.PHONY: join-test fake-tv release version upload-key ci-secrets play-check play-upload fake-releases store-images store-screens test-scripts bootstrap jdk sdk ffmpeg build test contracts models models-check gradle install connect logs meminfo device-info screens emulator demo clean

bootstrap: jdk sdk

jdk: $(JAVA_HOME)/bin/java

$(TOOLS)/jdk-$(JDK_VERSION)/Contents/Home/bin/java:
	@set -e; mkdir -p $(TOOLS); rm -f $(TOOLS)/$(JDK_FILE); \
	curl -fsSL -o $(TOOLS)/$(JDK_FILE) $(JDK_URL); \
	actual=$$(shasum -a 256 $(TOOLS)/$(JDK_FILE) | cut -d ' ' -f 1); \
	if [ "$$actual" != "$(JDK_SHA256)" ]; then rm -f $(TOOLS)/$(JDK_FILE); echo "$(JDK_FILE) has SHA-256 $$actual; the Makefile expects $(JDK_SHA256)" >&2; exit 1; fi; \
	tar -xzf $(TOOLS)/$(JDK_FILE) -C $(TOOLS) && rm $(TOOLS)/$(JDK_FILE)

sdk: $(SDKMANAGER) $(ADB)

$(TOOLS)/android-sdk/cmdline-tools/latest/bin/sdkmanager:
	@set -e; mkdir -p $(TOOLS)/android-sdk/cmdline-tools; rm -rf $(TOOLS)/cmdline-tools $(TOOLS)/$(CMDLINE_FILE); \
	curl -fsSL -o $(TOOLS)/$(CMDLINE_FILE) https://dl.google.com/android/repository/$(CMDLINE_FILE); \
	actual=$$(shasum -a 1 $(TOOLS)/$(CMDLINE_FILE) | cut -d ' ' -f 1); \
	if [ "$$actual" != "$(CMDLINE_SHA1)" ]; then rm -f $(TOOLS)/$(CMDLINE_FILE); echo "$(CMDLINE_FILE) has SHA-1 $$actual; the Makefile expects $(CMDLINE_SHA1)" >&2; exit 1; fi; \
	unzip -q $(TOOLS)/$(CMDLINE_FILE) -d $(TOOLS) && rm $(TOOLS)/$(CMDLINE_FILE); \
	rm -rf $(TOOLS)/android-sdk/cmdline-tools/latest && mv $(TOOLS)/cmdline-tools $(TOOLS)/android-sdk/cmdline-tools/latest

$(TOOLS)/android-sdk/platform-tools/adb: $(JAVA_HOME)/bin/java $(SDKMANAGER)
	@set -e; yes | $(SDKMANAGER) $(SDK_PROXY) --licenses >/dev/null; \
	$(SDKMANAGER) $(SDK_PROXY) $(foreach p,$(SDK_PACKAGES),'$(p)')

build:
	$(GRADLE) :app:assembleSideloadDebug

# `lint` alone checks one flavor (play); the sideload flavor has code of its own (updating itself).
test: test-scripts
	$(GRADLE) test lint :app:lintSideloadDebug

test-scripts:
	node --test scripts/*.test.mjs

contracts:
	$(GRADLE) :api:testDebugUnitTest --tests 'me.tracklistme.playarr.api.ContractTests'

models:
	node scripts/gen-models.mjs

models-check:
	node scripts/gen-models.mjs --check

gradle:
	$(GRADLE) $(ARGS)

connect:
	@case "$(TV)" in emulator-*) exit 0 ;; esac; \
	$(ADB) connect $(TV) | grep -q -E 'connected|already' || { echo "No answer from the TV at $(TV): is network debugging on (Settings → Developer options)?" >&2; exit 1; }

install: build connect
	$(ADB) -s $(TV) install -r $(APK)
	$(ADB) -s $(TV) shell am start -n $(APP_ID)/.MainActivity >/dev/null

logs: connect
	$(ADB) -s $(TV) logcat --pid=$$($(ADB) -s $(TV) shell pidof -s $(APP_ID))

meminfo: connect
	$(ADB) -s $(TV) shell dumpsys meminfo $(APP_ID) | sed -n '1,40p'

device-info: connect
	@set -e; a="$(ADB) -s $(TV) shell"; \
	echo "Android $$($$a getprop ro.build.version.release) (SDK $$($$a getprop ro.build.version.sdk)), firmware $$($$a getprop ro.build.display.id)"; \
	echo "low-RAM flag: $$($$a getprop ro.config.low_ram)"; \
	echo "heap limit: $$($$a getprop dalvik.vm.heapgrowthlimit) (large: $$($$a getprop dalvik.vm.heapsize))"; \
	$$a cat /proc/meminfo | sed -n '1,3p'; \
	$$a dumpsys webviewupdate | grep -m1 -i 'current webview package' || true

screens: connect
	@set -e; mkdir -p $(SCREENS_ROOT); f=$(SCREENS_ROOT)/$$(date +%Y%m%d-%H%M%S).png; \
	$(ADB) -s $(TV) exec-out screencap -p > $$f; echo "$$f"

emulator: $(JAVA_HOME)/bin/java $(SDKMANAGER)
	@set -e; \
	[ -d $(ANDROID_HOME)/system-images/android-36/android-tv ] || yes | $(SDKMANAGER) $(SDK_PROXY) emulator '$(EMULATOR_IMAGE)' >/dev/null; \
	[ -d $(ANDROID_AVD_HOME)/playarr-tv.avd ] || { mkdir -p $(ANDROID_AVD_HOME); echo no | $(ANDROID_HOME)/cmdline-tools/latest/bin/avdmanager create avd -n playarr-tv -k '$(EMULATOR_IMAGE)' -d tv_1080p >/dev/null; echo hw.ramSize=2048 >> $(ANDROID_AVD_HOME)/playarr-tv.avd/config.ini; }; \
	$(ADB) start-server >/dev/null; \
	$(ANDROID_HOME)/emulator/emulator -avd playarr-tv -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > build/emulator.log 2>&1 & \
	until [ "$$($(ADB) -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; do sleep 2; done; \
	echo "Emulator up: TV=emulator-5554 make install"

ffmpeg: $(TOOLS)/ffmpeg/ffmpeg

$(TOOLS)/ffmpeg/ffmpeg:
	@set -e; mkdir -p $(TOOLS)/ffmpeg; rm -f $(TOOLS)/ffmpeg.zip; \
	curl -fsSL -o $(TOOLS)/ffmpeg.zip $(FFMPEG_URL); \
	actual=$$(shasum -a 256 $(TOOLS)/ffmpeg.zip | cut -d ' ' -f 1); \
	if [ "$$actual" != "$(FFMPEG_SHA256)" ]; then rm -f $(TOOLS)/ffmpeg.zip; echo "ffmpeg.zip has SHA-256 $$actual; the Makefile expects $(FFMPEG_SHA256)" >&2; exit 1; fi; \
	unzip -q -o $(TOOLS)/ffmpeg.zip -d $(TOOLS)/ffmpeg && rm $(TOOLS)/ffmpeg.zip

# A release (plan 9 §7): the sideload APK for GitHub releases and the Play app bundle, signed with the upload key
# from PLAYARR_TV_KEYSTORE (+ _PASSWORD, PLAYARR_TV_KEY_ALIAS, PLAYARR_TV_KEY_PASSWORD), in build/release/. On a Mac they
# come from the repo's .env when the environment doesn't have them (`make upload-key` writes them there); CI sets them.
VERSION := $(shell sed -n 's/^ *versionName = "\(.*\)"/\1/p' app/build.gradle.kts)
ENV_FILE := $(wildcard ../../.env)
from_env = $(if $(ENV_FILE),$(shell sed -n 's/^$(1)=//p' $(ENV_FILE) | tail -n 1))
export PLAYARR_TV_KEYSTORE ?= $(call from_env,PLAYARR_TV_KEYSTORE)
export PLAYARR_TV_KEYSTORE_PASSWORD ?= $(call from_env,PLAYARR_TV_KEYSTORE_PASSWORD)
export PLAYARR_TV_KEY_ALIAS ?= $(call from_env,PLAYARR_TV_KEY_ALIAS)
export PLAY_SERVICE_ACCOUNT_FILE ?= $(call from_env,PLAY_SERVICE_ACCOUNT_FILE)
UPLOAD_KEY ?= $(HOME)/.playarr/playarr-tv-upload.jks

release:
	@[ -n "$$PLAYARR_TV_KEYSTORE" ] || { echo "No upload key: make upload-key, or set PLAYARR_TV_KEYSTORE (docs/tv/release.md)"; exit 1; }
	$(GRADLE) :app:assembleSideloadRelease :app:bundlePlayRelease
	@mkdir -p build/release
	cp app/build/outputs/apk/sideload/release/app-sideload-release.apk build/release/playarr-tv-$(VERSION).apk
	cp app/build/outputs/bundle/playRelease/app-play-release.aab build/release/playarr-tv-$(VERSION).aab
	@echo "build/release/playarr-tv-$(VERSION).apk and .aab"

version:
	@echo $(VERSION)

# The upload key, once: a PKCS12 keystore valid for 27 years (Play wants past 2033) with a random password, at
# UPLOAD_KEY outside the repo, its settings added to the repo's .env. A sideloaded TV only takes updates signed with
# it, so back up the file and the password together.
upload-key: $(JAVA_HOME)/bin/java
	@set -e; \
	if [ -e "$(UPLOAD_KEY)" ]; then echo "$(UPLOAD_KEY) exists already: it signs every release, so it's kept" >&2; exit 1; fi; \
	if [ -n "$$PLAYARR_TV_KEYSTORE" ]; then echo "An upload key is set already: $$PLAYARR_TV_KEYSTORE" >&2; exit 1; fi; \
	mkdir -p "$(dir $(UPLOAD_KEY))"; chmod 700 "$(dir $(UPLOAD_KEY))"; \
	password=$$(openssl rand -hex 24); \
	$(JAVA_HOME)/bin/keytool -genkeypair -keystore "$(UPLOAD_KEY)" -storetype PKCS12 -alias upload -keyalg RSA -keysize 4096 \
	  -validity 10000 -dname "CN=Playarr for TV" -storepass "$$password" -keypass "$$password" >/dev/null 2>&1; \
	chmod 600 "$(UPLOAD_KEY)"; \
	touch ../../.env; chmod 600 ../../.env; \
	{ echo; echo "# The TV app's upload key (make -C apps/tv upload-key, docs/tv/release.md): back up the file and the password together."; \
	  echo "PLAYARR_TV_KEYSTORE=$(UPLOAD_KEY)"; echo "PLAYARR_TV_KEYSTORE_PASSWORD=$$password"; echo "PLAYARR_TV_KEY_ALIAS=upload"; } >> ../../.env; \
	echo "Made $(UPLOAD_KEY), named in the repo's .env. Back it up with its password; then make ci-secrets."; \
	$(JAVA_HOME)/bin/keytool -list -v -keystore "$(UPLOAD_KEY)" -storepass "$$password" | grep -E "SHA256:" | head -n 1

# The upload key, and the Play service account when PLAY_SERVICE_ACCOUNT_FILE is set, as the repository's GitHub
# secrets (with gh, signed in to GitHub), for .github/workflows/tv.yml's release job.
ci-secrets:
	@set -e; \
	[ -n "$$PLAYARR_TV_KEYSTORE" ] || { echo "No upload key: make upload-key first" >&2; exit 1; }; \
	base64 < "$$PLAYARR_TV_KEYSTORE" | tr -d '\n' | gh secret set PLAYARR_TV_KEYSTORE_BASE64; \
	printf %s "$$PLAYARR_TV_KEYSTORE_PASSWORD" | gh secret set PLAYARR_TV_KEYSTORE_PASSWORD; \
	printf %s "$${PLAYARR_TV_KEY_ALIAS:-upload}" | gh secret set PLAYARR_TV_KEY_ALIAS; \
	if [ -n "$$PLAY_SERVICE_ACCOUNT_FILE" ]; then gh secret set PLAY_SERVICE_ACCOUNT_JSON < "$$PLAY_SERVICE_ACCOUNT_FILE"; fi; \
	gh secret list | grep -E 'PLAYARR_TV|PLAY_SERVICE'

play-check:
	node scripts/play-upload.mjs --check

# The release's bundle to a Play track from this Mac (TRACK=internal by default); a tv-v* tag does it on CI.
TRACK ?= internal
play-upload:
	node scripts/play-upload.mjs build/release/playarr-tv-$(VERSION).aab --track $(TRACK)

fake-releases:
	node scripts/fake-releases.mjs $(wildcard build/release/playarr-tv-*.apk)

store-images:
	swift scripts/store-images.swift

# The Play listing's TV screenshots (1920×1080), from the emulator signed in to `make demo`: Home, Library, an album
# (ALBUM, its id: 2 is the red Rewind) and Now Playing, paused on that album's first song.
ALBUM ?= 2
store-screens: connect
	@set -e; d=store/en-US/images/tv-screenshots; mkdir -p $$d; a="$(ADB) -s $(TV)"; \
	shot() { $$a shell am start -n $(APP_ID)/.MainActivity --es route "$$1" >/dev/null; sleep 5; $$a exec-out screencap -p > $$d/$$2.png; echo "$$d/$$2.png"; }; \
	shot Home 01-home; shot Library 02-library; shot album:$(ALBUM) 03-album; \
	$$a shell input keyevent DPAD_CENTER; sleep 3; $$a shell input keyevent MEDIA_PAUSE; shot NowPlaying 04-now-playing

demo: ffmpeg
	node scripts/demo-server.mjs

# A stand-in for the Philips TV's JointSpace (plan 9 §6) on the emulator: its own 127.0.0.1:1926 reaches this Mac's,
# where the fake answers pairing (the PIN is printed here) and prints the colors the Ambilight is sent.
fake-tv:
	$(ADB) -s emulator-5554 reverse tcp:1926 tcp:1926
	node scripts/fake-jointspace.mjs

# Plan 9 §4's join spike on the TV or the emulator: plays song, DJ transition, song (player/src/androidTest), pulls
# what reached the speakers and compares it with the signal, sample by sample (scripts/join-spike/).
join-test: connect
	ANDROID_SERIAL=$(TV) $(GRADLE) :player:installDebugAndroidTest
	$(ADB) -s $(TV) shell am instrument -w $(APP_ID:.tv=.player).test/androidx.test.runner.AndroidJUnitRunner
	rm -rf build/spike/out && mkdir -p build/spike/out
	$(ADB) -s $(TV) pull /sdcard/Android/data/$(APP_ID:.tv=.player).test/files/. build/spike/out/ >/dev/null
	node scripts/join-spike/make-signal.mjs >/dev/null && node scripts/join-spike/analyze.mjs whole server cut

clean:
	rm -rf build app/build .gradle
