import { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

export type AudioStreamerHandle = {
  pushPcm: (base64Pcm: string, sampleRate: number) => void;
  reset: () => void;
};

const HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#000;">
<script>
  var ctx = null;
  var nextStartTime = 0;

  function ensureCtx() {
    if (!ctx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function pushPcm(b64, sampleRate) {
    var c = ensureCtx();
    var bin = atob(b64);
    var byteLen = bin.length;
    var sampleCount = byteLen >> 1;
    var f32 = new Float32Array(sampleCount);
    for (var i = 0; i < sampleCount; i++) {
      var lo = bin.charCodeAt(i * 2);
      var hi = bin.charCodeAt(i * 2 + 1);
      var val = (hi << 8) | lo;
      if (val >= 0x8000) val -= 0x10000;
      f32[i] = val / 32768;
    }
    var buffer = c.createBuffer(1, sampleCount, sampleRate);
    buffer.copyToChannel(f32, 0);
    var src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    var startAt = Math.max(c.currentTime + 0.02, nextStartTime);
    src.start(startAt);
    nextStartTime = startAt + buffer.duration;
  }

  function reset() {
    nextStartTime = 0;
  }

  function handle(raw) {
    try {
      var m = JSON.parse(raw);
      if (m.type === 'pcm') pushPcm(m.data, m.sampleRate);
      else if (m.type === 'reset') reset();
    } catch (e) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(e) }));
      }
    }
  }

  window.pixxelHandle = handle;

  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  }
</script>
</body></html>`;

export const AudioStreamer = forwardRef<AudioStreamerHandle>(function AudioStreamer(_, ref) {
  const webRef = useRef<WebView | null>(null);

  useImperativeHandle(ref, () => ({
    pushPcm: (base64Pcm, sampleRate) => {
      const payload = JSON.stringify({ type: 'pcm', data: base64Pcm, sampleRate });
      webRef.current?.injectJavaScript(
        `window.pixxelHandle && window.pixxelHandle(${JSON.stringify(payload)}); true;`,
      );
    },
    reset: () => {
      webRef.current?.injectJavaScript(
        `window.pixxelHandle && window.pixxelHandle(${JSON.stringify(JSON.stringify({ type: 'reset' }))}); true;`,
      );
    },
  }));

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html: HTML }}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={(event) => {
          if (__DEV__) console.log('[streamer]', event.nativeEvent.data);
        }}
        style={styles.web}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  web: { flex: 1 },
});
