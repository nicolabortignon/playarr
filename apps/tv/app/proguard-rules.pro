# R8 for release builds. kotlinx.serialization, Media3, OkHttp and Coil bring their own rules; what's here is ours.

# Stack traces from the TV (logcat, Play's vitals) keep their line numbers.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
