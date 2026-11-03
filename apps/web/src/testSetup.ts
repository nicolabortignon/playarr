// Runs before every web test file (vitest.config.ts → setupFiles).

// happy-dom's Animation.cancel() throws where browsers reject a promise, which surfaces as unhandled
// "AbortError: The animation was canceled" whenever motion stops a native animation. Without
// Element.animate, motion runs its JavaScript animations instead, the same on every test file.
Reflect.deleteProperty(Element.prototype, 'animate');
