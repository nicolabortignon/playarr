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
#   make screens     screenshots of the main screens on the demo library, saved in build/screens/ (its own simulator)
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

test-app: project
	$(XCODEBUILD) test

# The ScreenTour UI test, on a simulator of its own (parallel UI tests on a shared one break each other): its screenshots
# land in build/screens/ (SCREENS_DIR reaches the test runner through xcodebuild's TEST_RUNNER_ prefix).
SCREENS_SIMULATOR := Playarr Screens
screens: project
	@set -e; xcrun simctl list devices available | grep -qE '^ +$(SCREENS_SIMULATOR) [(]' || xcrun simctl create "$(SCREENS_SIMULATOR)" "iPhone 17 Pro" >/dev/null
	rm -rf build/screens
	TEST_RUNNER_SCREENS_DIR=$(CURDIR)/build/screens $(MAKE) --no-print-directory SIMULATOR="$(SCREENS_SIMULATOR)" screens-run
	@echo "Screenshots in $(CURDIR)/build/screens"

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
