# Preserve line numbers and annotations for crash diagnostics & Capacitor reflection
-keepattributes SourceFile,LineNumberTable,*Annotation*,JavascriptInterface,Signature,InnerClasses,EnclosingMethod
-renamesourcefileattribute SourceFile

# Keep Capacitor core bridge & plugin reflection
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod public <methods>;
}

# Keep On My Disk native classes & registered Capacitor plugins
-keep class net.onmydisk.app.** { *; }
-keep class com.capacitorjs.plugins.pushnotifications.** { *; }
-keep class ee.forgr.capacitor_updater.** { *; }
-keep class com.getcapacitor.community.applesignin.** { *; }

# Keep WebView @JavascriptInterface bridges
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Suppress benign optional library warnings during R8 optimization
-dontwarn org.slf4j.**
-dontwarn javax.annotation.**
