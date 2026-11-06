import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

/* ------------------------------------------------------------------ */
/* Theme + helpers                                                     */
/* ------------------------------------------------------------------ */

const C = {
  bg: '#1F1612',
  surface: '#2B211C',
  orange: '#F89F2F',
  cream: '#F5E9DE',
  muted: '#B7A596',
  border: '#5A4A40',
  pill: 'rgba(38,29,24,0.78)',
  dark: '#1F1612',
};

const KEEP_AWAKE_TAG = 'posematch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const touchDist = (t) => {
  if (!t || t.length < 2) return 0;
  return Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
};
const getInterval = (auto) =>
  auto.interval === 'custom'
    ? clamp(parseInt(auto.custom, 10) || 5, 1, 600)
    : auto.interval;

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

function Pill({ icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
    >
      {icon ? <Ionicons name={icon} size={20} color={C.cream} /> : null}
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

function CircleButton({ icon, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.circleBtn, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={24} color={C.cream} />
    </Pressable>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <View style={styles.seg}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onChange(o.value)}
            style={[styles.segItem, selected && styles.segSelected]}
          >
            <Text style={[styles.segText, selected && styles.segTextSel]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Permission screen                                                   */
/* ------------------------------------------------------------------ */

function PermissionScreen({ canAsk, onAllow }) {
  return (
    <View style={[styles.root, styles.center, { padding: 32 }]}>
      <View style={styles.permIcon}>
        <Ionicons name="camera" size={44} color={C.orange} />
      </View>
      <Text style={styles.permTitle}>Camera access needed</Text>
      <Text style={styles.permText}>
        PoseMatch uses your camera to show a live preview, so you can line yourself up with a
        reference pose and take photos. Nothing is uploaded anywhere.
      </Text>
      {canAsk ? (
        <Pressable style={styles.bigBtn} onPress={onAllow}>
          <Text style={styles.bigBtnText}>Allow camera</Text>
        </Pressable>
      ) : (
        <Pressable style={styles.bigBtn} onPress={() => Linking.openSettings()}>
          <Text style={styles.bigBtnText}>Open settings</Text>
        </Pressable>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Camera screen                                                       */
/* ------------------------------------------------------------------ */

function CameraScreen({
  ov,
  setOv,
  auto,
  setAuto,
  lastPhoto,
  onSaved,
  onOpenGallery,
  onOpenLast,
  mediaPerm,
  requestMediaPerm,
}) {
  const insets = useSafeAreaInsets();
  const cameraRef = useRef(null);
  const [facing, setFacing] = useState('front');
  const [ready, setReady] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [run, setRun] = useState({ active: false, taken: 0, total: 0 });
  const [hint, setHint] = useState(null);

  const runId = useRef(0);
  const busy = useRef(false);
  const hintTimer = useRef(null);
  const flash = useRef(new Animated.Value(0)).current;
  const ovRef = useRef(ov);
  ovRef.current = ov;
  const mediaRef = useRef(mediaPerm);
  mediaRef.current = mediaPerm;

  useEffect(
    () => () => {
      runId.current += 1;
      clearTimeout(hintTimer.current);
      try {
        deactivateKeepAwake(KEEP_AWAKE_TAG);
      } catch {}
    },
    []
  );

  const showHint = (text) => {
    setHint(text);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2200);
  };

  /* ---------- overlay gestures: drag with 1 finger, pinch with 2 ---------- */
  const gesture = useRef({ n: 0, base: null, dist: 0, ox: 0, oy: 0 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!ovRef.current.uri && ovRef.current.visible,
      onMoveShouldSetPanResponder: () => !!ovRef.current.uri && ovRef.current.visible,
      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        gesture.current = { n: t.length, base: { ...ovRef.current }, dist: touchDist(t), ox: 0, oy: 0 };
      },
      onPanResponderMove: (e, gs) => {
        const t = e.nativeEvent.touches;
        const s = gesture.current;
        if (t.length !== s.n) {
          // finger count changed: restart from the current state
          s.n = t.length;
          s.base = { ...ovRef.current };
          s.dist = touchDist(t);
          s.ox = gs.dx;
          s.oy = gs.dy;
          return;
        }
        if (t.length >= 2 && s.dist > 0) {
          const scale = clamp(s.base.scale * (touchDist(t) / s.dist), 0.3, 5);
          setOv((o) => ({ ...o, scale }));
        } else if (t.length === 1) {
          const x = s.base.x + gs.dx - s.ox;
          const y = s.base.y + gs.dy - s.oy;
          setOv((o) => ({ ...o, x, y }));
        }
      },
    })
  ).current;

  /* ---------- reference photo ---------- */
  const pickReference = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      if (!res.canceled && res.assets && res.assets.length) {
        setOv((o) => ({ ...o, uri: res.assets[0].uri, x: 0, y: 0, scale: 1, visible: true }));
      }
    } catch {
      showHint('Could not open your photos');
    }
  };

  /* ---------- taking + saving a photo (overlay is NOT in the photo) ---------- */
  const capture = async () => {
    if (!cameraRef.current || busy.current) return false;
    busy.current = true;
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 1 });
      Vibration.vibrate(30);
      flash.setValue(0.85);
      Animated.timing(flash, { toValue: 0, duration: 300, useNativeDriver: true }).start();

      let granted = mediaRef.current && mediaRef.current.granted;
      if (!granted) {
        const r = await requestMediaPerm();
        granted = r && r.granted;
      }
      if (!granted) {
        showHint('Allow gallery access to save photos');
        return false;
      }
      const asset = await MediaLibrary.createAssetAsync(pic.uri);
      onSaved(asset);
      return true;
    } catch {
      showHint('Could not save photo');
      return false;
    } finally {
      busy.current = false;
    }
  };

  const onShutter = async () => {
    const ok = await capture();
    if (ok) showHint('Saved to gallery');
  };

  /* ---------- auto mode ---------- */
  const stopAuto = (done) => {
    runId.current += 1;
    setRun({ active: false, taken: 0, total: 0 });
    setCountdown(null);
    try {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    } catch {}
    if (done === true) showHint('All photos saved');
  };

  const startAuto = async () => {
    if (!ready) {
      showHint('Camera is not ready yet');
      return;
    }
    setSheet(false);
    const id = ++runId.current;
    const total = auto.count === 'unlimited' ? Infinity : auto.count;
    const secs = getInterval(auto);
    setRun({ active: true, taken: 0, total });
    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    } catch {}

    for (let n = 1; n <= total; n += 1) {
      for (let s = secs; s >= 1; s -= 1) {
        if (runId.current !== id) return;
        setCountdown(s);
        await sleep(1000);
      }
      if (runId.current !== id) return;
      setCountdown(null);
      await capture();
      if (runId.current !== id) return;
      setRun((r) => ({ ...r, taken: n }));
    }
    if (runId.current === id) stopAuto(true);
  };

  const goGallery = () => {
    if (run.active) stopAuto();
    onOpenGallery();
  };

  const goLast = () => {
    if (!lastPhoto) {
      showHint('No photos yet');
      return;
    }
    if (run.active) stopAuto();
    onOpenLast();
  };

  /* ---------- hint text under the camera ---------- */
  let hintText = hint;
  if (!hintText) {
    if (!ov.uri) hintText = 'Tap Pose to add a reference photo';
    else if (!ov.visible) hintText = 'Overlay hidden';
    else hintText = `Reference overlay ${Math.round(ov.opacity * 100)}%`;
  }

  const intervalLabel = `Auto ${getInterval(auto)}s`;

  return (
    <View style={styles.root}>
      <View style={styles.cameraWrap}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          onCameraReady={() => setReady(true)}
        />

        {/* Reference overlay (drag + pinch) */}
        {ov.uri && ov.visible ? (
          <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
            <Image
              pointerEvents="none"
              source={{ uri: ov.uri }}
              resizeMode="contain"
              style={{
                width: '100%',
                height: '100%',
                opacity: ov.opacity,
                transform: [
                  { translateX: ov.x },
                  { translateY: ov.y },
                  { scale: ov.scale },
                  { scaleX: ov.mirror ? -1 : 1 },
                ],
              }}
            />
          </View>
        ) : null}

        {/* Shutter flash */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flash }]}
        />

        {/* Top row: Mirror + Flip */}
        <View style={[styles.topRow, { top: insets.top + 10 }]}>
          <Pill
            icon="swap-horizontal"
            label="Mirror"
            onPress={() => setOv((o) => ({ ...o, mirror: !o.mirror }))}
          />
          <Pill
            icon="camera-reverse-outline"
            label="Flip"
            onPress={() => setFacing((f) => (f === 'front' ? 'back' : 'front'))}
          />
        </View>

        {/* Right column: Pose / Hide / Remove / Gallery */}
        <View style={[styles.rightCol, { top: insets.top + 70 }]}>
          <Pill icon="image-outline" label="Pose" onPress={pickReference} />
          {ov.uri ? (
            <Pill
              icon={ov.visible ? 'eye-off-outline' : 'eye-outline'}
              label={ov.visible ? 'Hide' : 'Show'}
              onPress={() => setOv((o) => ({ ...o, visible: !o.visible }))}
            />
          ) : null}
          {ov.uri ? (
            <Pill
              icon="close-circle-outline"
              label="Remove"
              onPress={() =>
                setOv((o) => ({ ...o, uri: null, x: 0, y: 0, scale: 1, visible: true }))
              }
            />
          ) : null}
          <Pill icon="images-outline" label="Gallery" onPress={goGallery} />
        </View>

        {/* Countdown */}
        {countdown !== null ? (
          <View pointerEvents="none" style={[styles.countWrap, { top: insets.top + 64 }]}>
            <View style={styles.countCircle}>
              <Text style={styles.countText}>{countdown}</Text>
            </View>
            <View style={styles.countLabel}>
              <Text style={styles.hintText}>
                {`Photo ${run.taken + 1}${Number.isFinite(run.total) ? ` of ${run.total}` : ''}`}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Hint pill */}
        <View pointerEvents="none" style={styles.hintWrap}>
          <View style={styles.hintPill}>
            <Text style={styles.hintText}>{hintText}</Text>
          </View>
        </View>
      </View>

      {/* Bottom bar */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.barCol}>
          <Pressable onPress={goLast} style={styles.thumb}>
            {lastPhoto ? (
              <Image source={{ uri: lastPhoto.uri }} style={styles.thumbImg} />
            ) : (
              <Ionicons name="image-outline" size={24} color={C.muted} />
            )}
          </Pressable>
          <Text style={styles.barLabel}>Last photo</Text>
        </View>

        <View style={styles.barCol}>
          <Pressable
            onPress={onShutter}
            disabled={run.active}
            style={({ pressed }) => [styles.shutterRing, pressed && { opacity: 0.8 }]}
          >
            <View style={[styles.shutterInner, run.active && { opacity: 0.4 }]} />
          </Pressable>
          <Text style={styles.barLabel}>Shutter</Text>
        </View>

        <View style={styles.barCol}>
          {run.active ? (
            <Pressable style={[styles.autoPill, styles.stopPill]} onPress={() => stopAuto()}>
              <Ionicons name="stop-circle-outline" size={22} color={C.cream} />
              <Text style={[styles.autoText, { color: C.cream }]}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.autoPill} onPress={() => setSheet(true)}>
              <Ionicons name="timer-outline" size={22} color={C.dark} />
              <Text style={styles.autoText}>{intervalLabel}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Auto settings sheet */}
      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetBackdrop}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheet(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Auto settings</Text>

            <Text style={styles.sheetLabel}>Interval between photos</Text>
            <Segmented
              value={auto.interval}
              onChange={(v) => setAuto((a) => ({ ...a, interval: v }))}
              options={[
                { label: '3s', value: 3 },
                { label: '5s', value: 5 },
                { label: '10s', value: 10 },
                { label: '15s', value: 15 },
                { label: 'Custom', value: 'custom' },
              ]}
            />
            {auto.interval === 'custom' ? (
              <View style={styles.customRow}>
                <TextInput
                  value={auto.custom}
                  onChangeText={(t) => setAuto((a) => ({ ...a, custom: t.replace(/[^0-9]/g, '') }))}
                  keyboardType="number-pad"
                  maxLength={3}
                  placeholder="20"
                  placeholderTextColor={C.muted}
                  style={styles.customInput}
                />
                <Text style={styles.customHint}>seconds (1 – 600)</Text>
              </View>
            ) : null}

            <Text style={styles.sheetLabel}>Number of photos</Text>
            <Segmented
              value={auto.count}
              onChange={(v) => setAuto((a) => ({ ...a, count: v }))}
              options={[
                { label: '5', value: 5 },
                { label: '10', value: 10 },
                { label: '20', value: 20 },
                { label: 'Unlimited', value: 'unlimited' },
              ]}
            />

            <View style={styles.opacityRow}>
              <Text style={styles.sheetLabel}>Overlay opacity</Text>
              <Text style={styles.opacityValue}>{Math.round(ov.opacity * 100)}%</Text>
            </View>
            <Slider
              minimumValue={0.1}
              maximumValue={1}
              value={ov.opacity}
              onValueChange={(v) => setOv((o) => ({ ...o, opacity: v }))}
              minimumTrackTintColor={C.orange}
              maximumTrackTintColor="#4A3C34"
              thumbTintColor={C.orange}
              style={{ height: 40 }}
            />

            <Pressable style={styles.bigBtn} onPress={startAuto}>
              <Text style={styles.bigBtnText}>Start auto photos</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Gallery screen                                                      */
/* ------------------------------------------------------------------ */

function GalleryScreen({ sessionPhotos, bump, onBack, onOpen }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState(sessionPhotos.length ? 'session' : 'all');
  const [all, setAll] = useState([]);
  const [cursor, setCursor] = useState(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState(null); // 'denied' | 'error'
  const busy = useRef(false);

  const load = useCallback(
    async (reset) => {
      if (busy.current) return;
      busy.current = true;
      try {
        let perm = await MediaLibrary.getPermissionsAsync();
        if (!perm.granted) perm = await MediaLibrary.requestPermissionsAsync();
        if (!perm.granted) {
          setProblem('denied');
          return;
        }
        setProblem(null);
        const res = await MediaLibrary.getAssetsAsync({
          first: 90,
          after: reset ? undefined : cursor,
          mediaType: MediaLibrary.MediaType.photo,
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        });
        setAll((prev) => (reset ? res.assets : [...prev, ...res.assets]));
        setCursor(res.endCursor);
        setHasMore(res.hasNextPage);
      } catch {
        setProblem('error');
      } finally {
        busy.current = false;
        setLoading(false);
      }
    },
    [cursor]
  );

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump]);

  const data = tab === 'session' ? sessionPhotos : all;
  const gap = 2;
  const size = (width - gap * 2) / 3;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <CircleButton icon="arrow-back" onPress={onBack} />
        <Text style={styles.headerTitle}>Gallery</Text>
        <View style={{ width: 48 }} />
      </View>

      <View style={styles.chips}>
        {[
          { key: 'session', label: 'This session' },
          { key: 'all', label: 'All photos' },
        ].map((c) => (
          <Pressable
            key={c.key}
            onPress={() => setTab(c.key)}
            style={[styles.chip, tab === c.key && styles.chipOn]}
          >
            <Text style={[styles.chipText, tab === c.key && styles.chipTextOn]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'all' && loading ? (
        <View style={[styles.center, { flex: 1 }]}>
          <ActivityIndicator color={C.orange} size="large" />
        </View>
      ) : tab === 'all' && problem ? (
        <View style={[styles.center, { flex: 1, padding: 32 }]}>
          <Text style={styles.permText}>
            {problem === 'denied'
              ? 'PoseMatch needs gallery access to show your photos.'
              : 'Could not load your photos.'}
          </Text>
          <Pressable
            style={styles.bigBtn}
            onPress={() => (problem === 'denied' ? Linking.openSettings() : load(true))}
          >
            <Text style={styles.bigBtnText}>
              {problem === 'denied' ? 'Open settings' : 'Try again'}
            </Text>
          </Pressable>
        </View>
      ) : data.length === 0 ? (
        <View style={[styles.center, { flex: 1, padding: 32 }]}>
          <Ionicons name="images-outline" size={48} color={C.muted} />
          <Text style={[styles.permText, { marginTop: 12 }]}>
            {tab === 'session'
              ? 'No photos taken yet. Go back and take some!'
              : 'No photos found.'}
          </Text>
        </View>
      ) : (
        <FlatList
          key={tab}
          data={data}
          numColumns={3}
          keyExtractor={(a) => a.id}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ gap, paddingBottom: insets.bottom + 12 }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (tab === 'all' && hasMore) load(false);
          }}
          renderItem={({ item, index }) => (
            <Pressable onPress={() => onOpen(data, index)}>
              <Image source={{ uri: item.uri }} style={{ width: size, height: size, backgroundColor: C.surface }} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Photo viewer ("Last photo")                                         */
/* ------------------------------------------------------------------ */

function ViewerScreen({ viewer, sessionIds, onBack, onBackToCamera, onDelete, onOpenGallery }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(viewer.index);
  const [areaH, setAreaH] = useState(0);
  const list = viewer.list;
  const current = list[index] || list[0];

  const share = async () => {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(current);
      const uri = info.localUri || info.uri;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri);
      } else {
        Alert.alert('Sharing is not available on this device');
      }
    } catch {
      Alert.alert('Could not share this photo');
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete photo?', 'This removes the photo from your phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(current) },
    ]);
  };

  const openMenu = () => {
    Alert.alert('Options', undefined, [
      { text: 'Open gallery', onPress: onOpenGallery },
      { text: 'Share', onPress: share },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const fromSession = current && sessionIds.has(current.id);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <CircleButton icon="arrow-back" onPress={onBack} />
        <Text style={styles.headerTitle}>{viewer.title}</Text>
        <CircleButton icon="ellipsis-vertical" onPress={openMenu} />
      </View>

      <View style={{ flex: 1 }} onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}>
        {areaH > 0 ? (
          <FlatList
            data={list}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(a) => a.id}
            initialScrollIndex={viewer.index}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            onMomentumScrollEnd={(e) =>
              setIndex(clamp(Math.round(e.nativeEvent.contentOffset.x / width), 0, list.length - 1))
            }
            renderItem={({ item }) => (
              <Image
                source={{ uri: item.uri }}
                resizeMode="contain"
                style={{ width, height: areaH, backgroundColor: '#000' }}
              />
            )}
          />
        ) : null}

        <View pointerEvents="none" style={styles.toast}>
          <View style={styles.toastCheck}>
            <Ionicons name="checkmark" size={20} color={C.dark} />
          </View>
          <Text style={styles.toastText}>{fromSession ? 'Saved to gallery' : 'In your gallery'}</Text>
          <Text style={styles.toastCount}>{`Photo ${index + 1} of ${list.length}`}</Text>
        </View>
      </View>

      <View style={[styles.viewerBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.barCol}>
          <Pressable style={styles.roundAction} onPress={share}>
            <Ionicons name="share-social-outline" size={26} color={C.cream} />
          </Pressable>
          <Text style={styles.barLabel}>Share</Text>
        </View>
        <View style={styles.barCol}>
          <Pressable style={styles.roundAction} onPress={confirmDelete}>
            <Ionicons name="trash-outline" size={26} color={C.cream} />
          </Pressable>
          <Text style={styles.barLabel}>Delete</Text>
        </View>
        <View style={styles.barCol}>
          <Pressable style={[styles.roundAction, styles.roundActionOn]} onPress={onBackToCamera}>
            <Ionicons name="camera-outline" size={28} color={C.dark} />
          </Pressable>
          <Text style={styles.barLabel}>Back to camera</Text>
        </View>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

function Root() {
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [mediaPerm, requestMediaPerm] = MediaLibrary.usePermissions();

  const [screen, setScreen] = useState('camera'); // camera | gallery | viewer
  const [viewer, setViewer] = useState(null); // { list, index, title, from }
  const [sessionPhotos, setSessionPhotos] = useState([]); // newest first
  const [bump, setBump] = useState(0);

  // Kept here so they survive going to the gallery and back
  const [ov, setOv] = useState({
    uri: null,
    x: 0,
    y: 0,
    scale: 1,
    mirror: false,
    opacity: 0.6,
    visible: true,
  });
  const [auto, setAuto] = useState({ interval: 5, custom: '20', count: 10 });

  // Ask for gallery access up front so auto mode is never interrupted later
  useEffect(() => {
    if (camPerm && camPerm.granted && mediaPerm && !mediaPerm.granted && mediaPerm.canAskAgain) {
      requestMediaPerm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camPerm && camPerm.granted, mediaPerm && mediaPerm.status]);

  const closeViewer = () => {
    const from = (viewer && viewer.from) || 'camera';
    setViewer(null);
    setScreen(from);
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'viewer') {
        closeViewer();
        return true;
      }
      if (screen === 'gallery') {
        setScreen('camera');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  });

  const openViewer = (list, index, title, from) => {
    setViewer({ list, index, title, from });
    setScreen('viewer');
  };

  const handleDelete = async (asset) => {
    try {
      const ok = await MediaLibrary.deleteAssetsAsync([asset]);
      if (ok === false) return;
      setSessionPhotos((p) => p.filter((a) => a.id !== asset.id));
      setBump((b) => b + 1);
      const list = viewer.list.filter((a) => a.id !== asset.id);
      if (list.length === 0) {
        closeViewer();
      } else {
        setViewer({ ...viewer, list, index: Math.min(viewer.index, list.length - 1) });
      }
    } catch {
      Alert.alert('Could not delete this photo');
    }
  };

  if (!camPerm) return <View style={styles.root} />;
  if (!camPerm.granted) {
    return <PermissionScreen canAsk={camPerm.canAskAgain} onAllow={requestCamPerm} />;
  }

  const sessionIds = new Set(sessionPhotos.map((a) => a.id));
  const showGallery = screen === 'gallery' || (screen === 'viewer' && viewer && viewer.from === 'gallery');

  return (
    <View style={styles.root}>
      {screen === 'camera' ? (
        <CameraScreen
          ov={ov}
          setOv={setOv}
          auto={auto}
          setAuto={setAuto}
          lastPhoto={sessionPhotos[0] || null}
          onSaved={(asset) => setSessionPhotos((p) => [asset, ...p])}
          onOpenGallery={() => setScreen('gallery')}
          onOpenLast={() => openViewer(sessionPhotos, 0, 'Last photo', 'camera')}
          mediaPerm={mediaPerm}
          requestMediaPerm={requestMediaPerm}
        />
      ) : null}

      {showGallery ? (
        <GalleryScreen
          sessionPhotos={sessionPhotos}
          bump={bump}
          onBack={() => setScreen('camera')}
          onOpen={(list, index) => openViewer(list, index, 'Photo', 'gallery')}
        />
      ) : null}

      {screen === 'viewer' && viewer ? (
        <ViewerScreen
          key={`${viewer.list.length}-${viewer.index}`}
          viewer={viewer}
          sessionIds={sessionIds}
          onBack={closeViewer}
          onBackToCamera={() => {
            setViewer(null);
            setScreen('camera');
          }}
          onDelete={handleDelete}
          onOpenGallery={() => {
            setViewer(null);
            setScreen('gallery');
          }}
        />
      ) : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Root />
    </SafeAreaProvider>
  );
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },

  /* camera */
  cameraWrap: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  topRow: {
    position: 'absolute',
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rightCol: { position: 'absolute', right: 14, alignItems: 'flex-end', gap: 10 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.pill,
    paddingHorizontal: 14,
    height: 42,
    borderRadius: 21,
  },
  pillText: { color: C.cream, fontSize: 15, fontWeight: '600' },
  countWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  countCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(38,29,24,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { color: C.orange, fontSize: 52, fontWeight: '700' },
  countLabel: {
    marginTop: 8,
    backgroundColor: C.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
  },
  hintWrap: { position: 'absolute', bottom: 16, left: 0, right: 0, alignItems: 'center' },
  hintPill: {
    backgroundColor: 'rgba(38,29,24,0.85)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  hintText: { color: C.cream, fontSize: 15, fontWeight: '500' },

  /* bottom bar */
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: C.bg,
    paddingTop: 14,
    paddingHorizontal: 8,
  },
  barCol: { flex: 1, alignItems: 'center' },
  barLabel: { color: C.cream, fontSize: 14, fontWeight: '500', marginTop: 6 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginTop: 9,
  },
  thumbImg: { width: '100%', height: '100%' },
  shutterRing: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: C.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: C.orange },
  autoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.orange,
    paddingHorizontal: 16,
    height: 52,
    borderRadius: 26,
    marginTop: 11,
  },
  stopPill: { backgroundColor: '#8E3B2F' },
  autoText: { color: C.dark, fontSize: 17, fontWeight: '700' },

  /* auto sheet */
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: C.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#6B5B50',
    marginBottom: 14,
  },
  sheetTitle: { color: C.cream, fontSize: 28, fontWeight: '700', marginBottom: 16 },
  sheetLabel: { color: C.cream, fontSize: 18, fontWeight: '500', marginTop: 12, marginBottom: 10 },
  seg: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 24,
    padding: 3,
  },
  segItem: { flex: 1, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  segSelected: { backgroundColor: C.orange },
  segText: { color: C.cream, fontSize: 16, fontWeight: '600' },
  segTextSel: { color: C.dark },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  customInput: {
    width: 90,
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    color: C.cream,
    fontSize: 18,
    textAlign: 'center',
  },
  customHint: { color: C.muted, fontSize: 15 },
  opacityRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  opacityValue: { color: C.muted, fontSize: 16, marginTop: 12 },
  bigBtn: {
    backgroundColor: C.orange,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    alignSelf: 'stretch',
  },
  bigBtnText: { color: C.dark, fontSize: 20, fontWeight: '700' },

  /* permission */
  permIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  permTitle: { color: C.cream, fontSize: 24, fontWeight: '700', marginBottom: 10 },
  permText: { color: C.muted, fontSize: 16, lineHeight: 23, textAlign: 'center' },

  /* headers (gallery + viewer) */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
    backgroundColor: C.bg,
  },
  headerTitle: { color: C.cream, fontSize: 24, fontWeight: '600', flex: 1, marginLeft: 14 },
  circleBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* gallery */
  chips: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingBottom: 12 },
  chip: {
    paddingHorizontal: 16,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: C.orange, borderColor: C.orange },
  chipText: { color: C.cream, fontSize: 15, fontWeight: '600' },
  chipTextOn: { color: C.dark },

  /* viewer */
  toast: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(31,22,18,0.96)',
    paddingHorizontal: 18,
    height: 66,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  toastCheck: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: { color: C.cream, fontSize: 18, fontWeight: '600', flex: 1 },
  toastCount: { color: C.muted, fontSize: 16 },
  viewerBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: C.bg,
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  roundAction: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundActionOn: { backgroundColor: C.orange },
});
