# Playarr iOS app: every entry point. The root package.json's `pnpm ios:*` scripts call these targets.
#
#   make bootstrap   download the pinned XcodeGen into .tools/ and generate Playarr.xcodeproj
#   make build       simulator build (SIMULATOR="iPad Pro 13-inch (M5)" picks another)
#   make test        the scripts' tests, `swift test` in each package, then the UI tests on a simulator
#   make setup       register the bundle id; once the app record exists, the "Household" TestFlight group
#                    (TESTERS="a@example.com b@example.com" adds those App Store Connect users to it)
#   make beta        test, then archive, upload and hand the build to TestFlight (beta-upload skips the tests)
#   make device      build and install on a paired iPhone (DEVICE="name or UDID" picks one)
#   make screenshots the App Store screenshots: a local server with the Creative Commons albums and the
#                    StoreScreenshots UI test on simulators of their own (SETS="ipad-13" takes only that set)
#   make store-check check the App Store text, settings and screenshots in store/ against Apple's limits
#   make release     test, then put MARKETING_VERSION on the App Store and submit it for review
#                    (release-submit skips the tests); VERSION=1.1.0 sets and commits a new version first,
#                    DRY_RUN=1 changes nothing and prints what would change (and skips the tests)
#   make screens     screenshots of the main views on the demo library, per device, in screenshots/ at the repo root
#   make models      regenerate PlayarrAPI's Swift models from the shared TypeScript types (models-check: up to date?)
#   make clean      remove build output and the generated project
#
# Every target that builds regenerates Playarr.xcodeproj first, so added and removed files are picked up.
# macOS ships GNU Make 3.81: no .ONESHELL or .SHELLFLAGS, so a line with several commands starts with `set -e`.

SHELL := /bin/bash

XCODEGEN_VERSION := 2.46.0
# SHA-256 of that release's xcodegen.zip. On a mismatch the download is deleted and make stops.
XCODEGEN_SHA256 := 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806
XCODEGEN := .tools/xcodegen-$(XCODEGEN_VERSION)/bin/xcodegen

PACKAGES := PlayarrAPI PlayarrPlayer PlayarrUI
SIMULATOR ?= iPhone 17 Pro
# That simulator's id, or the first available iPhone's when this Xcode has none by that name.
SIMULATOR_ID = $(shell { xcrun simctl list devices available | grep -E '^ +$(SIMULATOR) [(][0-9A-F-]{36}[)]'; xcrun simctl list devices available | grep -E '^ +iPhone'; } | head -1 | grep -oE '[0-9A-F-]{36}')
# -IDEPackageSupportDisableManifestSandbox: SwiftPM can't sandbox package manifests inside another sandbox (Claude's shell).
# -Xfrontend -disable-sandbox: nor can the compiler sandbox the macro plugins it runs (@Observable).
XCODEBUILD = xcodebuild -project Playarr.xcodeproj -scheme Playarr -derivedDataPath build/DerivedData \
  -IDEPackageSupportDisableManifestSandbox=YES -destination 'platform=iOS Simulator,id=$(SIMULATOR_ID)' \
  CURRENT_PROJECT_VERSION=$$(git rev-list --count HEAD) 'OTHER_SWIFT_FLAGS=$$(inherited) -Xfrontend -disable-sandbox'
# The repo's .env has ASC_KEY_ID, ASC_ISSUER_ID, APPLE_TEAM_ID and IOS_BUNDLE_ID; CI sets them itself.
NODE = node --env-file-if-exists=../../.env

.PHONY: bootstrap tools project build test test-scripts test-packages test-app screens models models-check setup crashes beta beta-upload device screenshots store-check release release-submit clean

bootstrap: project

tools: $(XCODEGEN)

$(XCODEGEN):
	mkdir -p .tools && rm -rf .tools/xcodegen .tools/xcodegen.zip
	curl -fsSL -o .tools/xcodegen.zip https://github.com/yonaskolb/XcodeGen/releases/download/$(XCODEGEN_VERSION)/xcodegen.zip
	@actual=$$(shasum -a 256 .tools/xcodegen.zip | cut -d ' ' -f 1); \
	if [ "$$actual" != "$(XCODEGEN_SHA256)" ]; then \
	  rm -f .tools/xcodegen.zip; \
	  echo "xcodegen.zip $(XCODEGEN_VERSION) has SHA-256 $$actual; the Makefile expects $(XCODEGEN_SHA256)" >&2; \
	  exit 1; \
	fi
	unzip -q .tools/xcodegen.zip -d .tools && mv .tools/xcodegen .tools/xcodegen-$(XCODEGEN_VERSION) && rm .tools/xcodegen.zip

project: $(XCODEGEN)
	$(XCODEGEN) generate --spec project.yml --quiet

build: project
	$(XCODEBUILD) build

test: test-scripts test-packages test-app

test-scripts:
	node --test 'scripts/*.test.mjs'

# --disable-sandbox: as above, for `swift test`.
test-packages:
	@set -e; for p in $(PACKAGES); do echo "▸ swift test $$p"; swift test --disable-sandbox --package-path Packages/$$p; done

# ONLY="AccessibilityAuditTests IPadLayoutTests" runs just those UI test classes.
test-app: project
	$(XCODEBUILD) test $(foreach t,$(ONLY),-only-testing:PlayarrUITests/$(t))

# The ScreenTour UI test on simulators of its own (parallel UI tests on a shared one break each other): the main views
# of each device, upright and (iPhone) sideways, in screenshots/<device>/ at the repo root, replaced on every run
# (SCREENS_DIR reaches the test runner through xcodebuild's TEST_RUNNER_ prefix). SCREENS="ipad" takes one device.
SCREENS_ROOT := $(abspath $(CURDIR)/../../screenshots)
# name|device type[|runtime]: the iPhone Duo runs only on its own iOS 27 runtime.
SCREENS_DEVICES := "iphone|iPhone 17 Pro" "ipad|iPad Pro 13-inch (M5)" "duo|iPhone Duo|com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4"
SCREENS ?= iphone ipad duo
# The demo albums' real covers for these screenshots only, downloaded once (scripts/screens-covers.mjs): the app and
# the App Store screenshots keep the demo's drawn ones.
SCREENS_COVERS := $(CURDIR)/build/screens-covers
screens: project
	@$(NODE) scripts/screens-covers.mjs "$(SCREENS_COVERS)"
	@set -e; for pair in $(SCREENS_DEVICES); do \
	  name=$${pair%%|*}; rest=$${pair#*|}; type=$${rest%%|*}; runtime=$$([ "$$rest" != "$$type" ] && echo "$${rest#*|}" || true); \
	  case " $(SCREENS) " in *" $$name "*) ;; *) continue ;; esac; \
	  sim="Playarr Screens $$name"; \
	  xcrun simctl list devices available | grep -qF "    $$sim (" || xcrun simctl create "$$sim" "$$type" $$runtime >/dev/null; \
	  rm -rf "$(SCREENS_ROOT)/$$name" "$(SCREENS_ROOT)/$$name-sideways"; \
	  echo "▸ $$name on $$type"; \
	  TEST_RUNNER_SCREENS_DIR="$(SCREENS_ROOT)/$$name" TEST_RUNNER_PLAYARR_DEMO_COVERS="$(SCREENS_COVERS)" \
	    $(MAKE) --no-print-directory SIMULATOR="$$sim" screens-run; \
	done
	@echo "Screenshots in $(SCREENS_ROOT)"

screens-run:
	$(XCODEBUILD) test -only-testing:PlayarrUITests/ScreenTour

# Swift models from the shared TypeScript types (committed).
models:
	node scripts/gen-models.mjs

# Fails when Models.generated.swift is out of date.
models-check:
	node scripts/gen-models.mjs --check

setup:
	$(NODE) scripts/asc.mjs setup $(TESTERS)

# Crash reports sent from TestFlight not looked at yet, logs saved in build/crashes/.
crashes:
	$(NODE) scripts/asc.mjs crashes

beta: test
	$(MAKE) beta-upload

beta-upload: project
	$(NODE) scripts/release.mjs beta

device: project
	$(NODE) scripts/release.mjs device

screenshots: project
	$(NODE) scripts/screenshots.mjs $(SETS)

store-check:
	$(NODE) scripts/release.mjs check-store

release: $(if $(DRY_RUN),,test)
	$(MAKE) release-submit

release-submit: project
	$(NODE) scripts/release.mjs release $(VERSION) $(if $(DRY_RUN),--dry-run)

clean:
	rm -rf build Playarr.xcodeproj Packages/*/.build
