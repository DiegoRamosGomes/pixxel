import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AudioStreamer, type AudioStreamerHandle } from './src/lib/audio-streamer';
import { GeminiLiveClient, type LiveStatus } from './src/lib/gemini-live';
import { buildSystemInstruction } from './src/lib/system-instruction';

type Msg = { role: 'user' | 'model'; text: string };

const STATUS_COLOR: Record<LiveStatus, string> = {
  idle: 'rgba(231, 240, 255, 0.3)',
  connecting: '#e6c84a',
  ready: '#5fc9e6',
  error: '#e25555',
  closed: '#cf8a3a',
};

const STATUS_LABEL: Record<LiveStatus, string> = {
  idle: 'desconectado',
  connecting: 'conectando',
  ready: 'pronto',
  error: 'erro',
  closed: 'fechado',
};

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '';

export default function App() {
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [statusInfo, setStatusInfo] = useState<string | undefined>();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const streamingRef = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const audioRef = useRef<AudioStreamerHandle | null>(null);

  useEffect(() => {
    if (!API_KEY) {
      setStatus('error');
      setStatusInfo('EXPO_PUBLIC_GEMINI_API_KEY não configurada');
      return;
    }
    const client = new GeminiLiveClient(API_KEY, {
      onStatus: (next, info) => {
        setStatus(next);
        setStatusInfo(info);
      },
      onTextChunk: (chunk) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (streamingRef.current && last && last.role === 'model') {
            const next = prev.slice(0, -1);
            next.push({ role: 'model', text: last.text + chunk });
            return next;
          }
          streamingRef.current = true;
          return [...prev, { role: 'model', text: chunk }];
        });
      },
      onTurnComplete: () => {
        streamingRef.current = false;
      },
      onAudioChunk: (base64Pcm, sampleRate) => {
        audioRef.current?.pushPcm(base64Pcm, sampleRate);
      },
      onInterrupted: () => {
        audioRef.current?.reset();
      },
    });
    clientRef.current = client;
    client.start(buildSystemInstruction());
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, []);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || status !== 'ready') return;
    const sent = clientRef.current?.sendText(trimmed);
    if (!sent) return;
    setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
  };

  const empty = messages.length === 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="light" />
      <AudioStreamer ref={audioRef} />
      <View style={styles.header}>
        <Text style={styles.brand}>Pixxel</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: STATUS_COLOR[status] }]} />
          <Text style={styles.statusText}>
            {STATUS_LABEL[status]}
            {statusInfo ? ` · ${statusInfo}` : ''}
          </Text>
        </View>
      </View>

      {empty ? (
        <View style={styles.emptyWrap}>
          <View style={[styles.orb, { borderColor: STATUS_COLOR[status] }]}>
            <View style={styles.orbInner} />
          </View>
          <Text style={styles.hint}>
            {status === 'ready' ? 'mandá uma mensagem' : 'aguardando conexão'}
          </Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map((msg, idx) => (
            <View
              key={idx}
              style={[
                styles.bubble,
                msg.role === 'user' ? styles.bubbleUser : styles.bubbleModel,
              ]}
            >
              <Text
                style={msg.role === 'user' ? styles.bubbleTextUser : styles.bubbleTextModel}
              >
                {msg.text}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="mensagem…"
          placeholderTextColor="rgba(231, 240, 255, 0.35)"
          editable={status === 'ready'}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          blurOnSubmit={false}
        />
        <Pressable
          style={[
            styles.sendBtn,
            (status !== 'ready' || input.trim() === '') && styles.sendBtnDisabled,
          ]}
          onPress={handleSend}
          disabled={status !== 'ready' || input.trim() === ''}
        >
          <Text style={styles.sendBtnText}>enviar</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0e1a',
    paddingTop: 56,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(120, 180, 255, 0.08)',
  },
  brand: {
    color: '#e7f0ff',
    fontSize: 22,
    fontWeight: '300',
    letterSpacing: 5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    color: 'rgba(231, 240, 255, 0.55)',
    fontSize: 12,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
  },
  orb: {
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbInner: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(80, 160, 255, 0.16)',
  },
  hint: {
    color: 'rgba(231, 240, 255, 0.5)',
    fontSize: 13,
    letterSpacing: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 20,
    gap: 12,
  },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(80, 160, 255, 0.22)',
    borderBottomRightRadius: 4,
  },
  bubbleModel: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(231, 240, 255, 0.06)',
    borderBottomLeftRadius: 4,
  },
  bubbleTextUser: {
    color: '#e7f0ff',
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleTextModel: {
    color: 'rgba(231, 240, 255, 0.92)',
    fontSize: 15,
    lineHeight: 21,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(120, 180, 255, 0.08)',
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(231, 240, 255, 0.05)',
    color: '#e7f0ff',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    fontSize: 15,
  },
  sendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(80, 160, 255, 0.28)',
  },
  sendBtnDisabled: {
    opacity: 0.35,
  },
  sendBtnText: {
    color: '#e7f0ff',
    fontSize: 14,
    fontWeight: '500',
  },
});
