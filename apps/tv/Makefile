# Playarr on the TV (plan 9): every entry point. The root package.json's `pnpm tv:*` scripts call these targets.
#
#   make bootstrap   download the pinned JDK and Android SDK into .tools/ (checksums checked), accept the SDK's licenses
#   make build       a debug APK (app/build/outputs/apk/debug/)
#   make test        the unit tests (the contract tests among them) and Android Lint
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

.PHONY: join-test fake-tv release version bootstrap jdk sdk ffmpeg build test contracts models models-check gradle install connect logs meminfo device-info screens emulator demo clean

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

test:
	$(GRADLE) test lint

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
# from PLAYARR_TV_KEYSTORE (+ _PASSWORD, PLAYARR_TV_KEY_ALIAS, PLAYARR_TV_KEY_PASSWORD), in build/release/.
VERSION := $(shell sed -n 's/^ *versionName = "\(.*\)"/\1/p' app/build.gradle.kts)
release:
	@[ -n "$$PLAYARR_TV_KEYSTORE" ] || { echo "PLAYARR_TV_KEYSTORE isn't set: see docs/tv/release.md"; exit 1; }
	$(GRADLE) :app:assembleSideloadRelease :app:bundlePlayRelease
	@mkdir -p build/release
	cp app/build/outputs/apk/sideload/release/app-sideload-release.apk build/release/playarr-tv-$(VERSION).apk
	cp app/build/outputs/bundle/playRelease/app-play-release.aab build/release/playarr-tv-$(VERSION).aab
	@echo "build/release/playarr-tv-$(VERSION).apk and .aab"

version:
	@echo $(VERSION)

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
