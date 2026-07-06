import { useState, useEffect, useRef } from "react";

function App() {
  const [token, setToken] = useState(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [player, setPlayer] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [currentTrackId, setCurrentTrackId] = useState(null);
  const [isPaused, setIsPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  // Prevents the completion popup from firing more than once for the
  // same "playlist ended" moment.
  const completionShownRef = useRef(false);

  // Tracks whether playback was actively going, so we can distinguish
  // "song just ended naturally" from "nothing has played yet".
  const wasPlayingRef = useRef(false);

  // Tracks whether the CURRENT track has actually made real progress
  // (a few real seconds), so a buffering blip right at track-start —
  // which can briefly report paused + position 0 — doesn't get
  // mistaken for "the playlist just finished". Reset per track.
  const hasProgressedRef = useRef(false);

  // Tracks the most recent reshuffle so a slower, older request can't
  // queue its (stale) songs after a newer one already has.
  const requestIdRef = useRef(0);

  // Holds the latest shuffled list waiting to take over once the
  // currently playing song ends. Overwritten on every new reshuffle,
  // so only the most recent click ever actually gets applied.
  const pendingSongsRef = useRef(null);

  // Plain ref for comparing track changes — kept separate from React
  // state so we don't need side effects inside a state updater.
  const prevTrackIdRef = useRef(null);

  // --- Token refresh tracking ---
  // Spotify access tokens expire after 1 hour. Rather than let calls
  // silently fail once that happens (which is exactly what caused the
  // confusing 502-style errors during testing), we track the refresh
  // token and expiry time, and transparently refresh before any call
  // that needs a token — including the SDK's own internal requests.
  const refreshTokenRef = useRef(null);
  const tokenExpiresAtRef = useRef(null); // epoch ms
  // Always holds the latest known-good access token. Kept in sync with
  // the `token` state below, but readable synchronously from inside
  // callbacks (like the SDK's getOAuthToken) without waiting on React.
  const accessTokenRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get("access_token");
    if (accessToken) {
      setToken(accessToken);
      accessTokenRef.current = accessToken;
      refreshTokenRef.current = params.get("refresh_token");
      const expiresIn = parseInt(params.get("expires_in"), 10) || 3600;
      // Refresh a little early (60s buffer) rather than cutting it
      // exactly at the expiry boundary.
      tokenExpiresAtRef.current = Date.now() + (expiresIn - 60) * 1000;
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Returns a currently-valid access token, transparently refreshing
  // it first if it's expired (or about to expire). Every Spotify API
  // call — and the SDK's own token requests — should go through this
  // instead of reading `token` directly, so a stale token never
  // silently causes calls to fail.
  const getValidAccessToken = async () => {
    const stillValid =
      tokenExpiresAtRef.current && Date.now() < tokenExpiresAtRef.current;
    if (stillValid) return accessTokenRef.current;

    if (!refreshTokenRef.current) {
      // No refresh token available (shouldn't normally happen) —
      // fall back to whatever we have rather than crashing.
      return accessTokenRef.current;
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:5000/refresh_token?refresh_token=${refreshTokenRef.current}`
      );
      const data = await response.json();
      if (data.error) {
        console.error("Token refresh failed:", data.error);
        return accessTokenRef.current;
      }
      accessTokenRef.current = data.access_token;
      refreshTokenRef.current = data.refresh_token;
      tokenExpiresAtRef.current = Date.now() + (data.expires_in - 60) * 1000;
      setToken(data.access_token);
      return data.access_token;
    } catch (err) {
      console.error("Token refresh request failed:", err);
      return accessTokenRef.current;
    }
  };

  useEffect(() => {
    if (!token) return;

    const initPlayer = () => {
      const spotifyPlayer = new window.Spotify.Player({
        name: "Serendify Player",
        getOAuthToken: (cb) => {
          getValidAccessToken().then(cb);
        },
        volume: 0.5,
      });

      spotifyPlayer.addListener("ready", ({ device_id }) => {
        setDeviceId(device_id);
      });

      spotifyPlayer.addListener("player_state_changed", (state) => {
        if (!state) return;
        const newTrackId = state.track_window.current_track.id;
        const prevTrackId = prevTrackIdRef.current;

        // The track actually changed (i.e. the previous song ended /
        // moved on) — if a reshuffle is waiting, apply it now.
        if (
          prevTrackId &&
          prevTrackId !== newTrackId &&
          pendingSongsRef.current
        ) {
          const songsToPlay = pendingSongsRef.current;
          pendingSongsRef.current = null;
          playQueueFrom(0, songsToPlay);
        }

        // Reset the "has this actually played for a bit" guard whenever
        // we land on a genuinely different track.
        if (prevTrackId !== newTrackId) {
          hasProgressedRef.current = false;
        }
        // Mark real progress once we're a few seconds into the track —
        // this is what separates a startup buffering blip from an
        // actual natural ending later on.
        if (state.position > 3000) {
          hasProgressedRef.current = true;
        }

        prevTrackIdRef.current = newTrackId;
        setCurrentTrackId(newTrackId);
        setIsPaused(state.paused);
        setPosition(state.position);
        setDuration(state.duration);

        // Detect "the whole playlist just finished". When a track ends
        // naturally (rather than being paused by the user mid-song),
        // Spotify's SDK typically reports paused:true with position
        // reset to 0 — not sitting at the end. So the real signal here
        // is: the track had genuinely been playing for a while, then
        // abruptly went to paused + position 0 + nothing queued next.
        const wasPlaying = wasPlayingRef.current;
        const noNextTracks =
          !state.track_window.next_tracks ||
          state.track_window.next_tracks.length === 0;
        const looksLikeNaturalEnd =
          state.position === 0 || state.position >= state.duration - 1000;

        if (
          wasPlaying &&
          hasProgressedRef.current &&
          state.paused &&
          noNextTracks &&
          looksLikeNaturalEnd &&
          !pendingSongsRef.current &&
          !completionShownRef.current
        ) {
          completionShownRef.current = true;
          setShowCompletionModal(true);
        }

        if (!state.paused) {
          // Actively playing — reset guards so the popup can fire
          // again for a future playlist ending.
          completionShownRef.current = false;
        }
        wasPlayingRef.current = !state.paused;
      });

      spotifyPlayer.connect();
      setPlayer(spotifyPlayer);
    };

    // The SDK script (loaded in index.html) sets window.spotifySDKReady
    // to true via its own onSpotifyWebPlaybackSDKReady callback, which
    // can fire before or after this effect runs. Poll briefly instead
    // of relying on exact timing either way.
    if (window.spotifySDKReady && window.Spotify) {
      initPlayer();
    } else {
      const interval = setInterval(() => {
        if (window.spotifySDKReady && window.Spotify) {
          clearInterval(interval);
          initPlayer();
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [token]);

  useEffect(() => {
    if (isPaused) return;
    const interval = setInterval(() => {
      setPosition((p) => Math.min(p + 1000, duration));
    }, 1000);
    return () => clearInterval(interval);
  }, [isPaused, duration]);

  const handleSerendify = async () => {
    // Ignore this click if a newer reshuffle has already started.
    const myRequestId = ++requestIdRef.current;
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const validToken = await getValidAccessToken();
      const response = await fetch("http://127.0.0.1:5000/shuffle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ playlist_url: playlistUrl }),
      });
      const data = await response.json();

      // A newer request started while we were fetching — drop these
      // stale results instead of showing/queueing an outdated shuffle.
      if (myRequestId !== requestIdRef.current) {
        setLoading(false);
        return;
      }

      if (data.error) {
        setError(data.error);
      } else {
        setSongs(data.songs);
        // If something is playing, don't interrupt it — just remember
        // this shuffle. Once the current song actually ends, the
        // player_state_changed listener will pick it up and switch to
        // song #1 of it. If more clicks come in before that happens,
        // this simply gets overwritten, so only the latest one applies.
        if (!isPaused && deviceId) {
          pendingSongsRef.current = data.songs;
        }
      }
    } catch (err) {
      setError("Something went wrong. Try again.");
    }
    setLoading(false);
  };

  // Spotify's Web API is known to intermittently return 502 (Bad
  // Gateway) on /me/player/play and related endpoints, especially
  // right after a track transition. This isn't something in our
  // control — it's a documented, widely-reported flakiness on
  // Spotify's own servers. Retrying after a short delay reliably
  // works around it.
  const fetchWithRetry = async (url, options, retries = 3, delayMs = 600) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await fetch(url, options);
      if (response.status !== 502) return response;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  };

  const playQueueFrom = async (index, songList = songs) => {
    if (!deviceId) return;
    // A direct play call takes precedence — drop any reshuffle that
    // was waiting to take over once the previous song ended.
    pendingSongsRef.current = null;
    const MAX_QUEUE_SIZE = 500;
    const uris = songList
      .slice(index, index + MAX_QUEUE_SIZE)
      .map((s) => `spotify:track:${s.id}`);
    const validToken = await getValidAccessToken();
    await fetchWithRetry(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ uris }),
      }
    );
    // Force repeat off — otherwise Spotify's device-level repeat
    // setting (often left on from a previous session) will just
    // loop the last track instead of actually stopping, and our
    // "playlist finished" popup would never get a chance to fire.
    await fetchWithRetry(
      `https://api.spotify.com/v1/me/player/repeat?state=off&device_id=${deviceId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      }
    );
  };

  const togglePlay = () => {
    if (player) player.togglePlay();
  };

  const skipNext = () => {
    if (player) player.nextTrack();
  };

  const skipPrevious = () => {
    if (player) player.previousTrack();
  };

  const handleSeek = (e) => {
    const newPosition = Number(e.target.value);
    setPosition(newPosition);
    if (player) player.seek(newPosition);
  };

  const formatTime = (ms) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const handleLogout = () => {
    if (player) {
      player.disconnect();
    }
    setToken(null);
    accessTokenRef.current = null;
    refreshTokenRef.current = null;
    tokenExpiresAtRef.current = null;
    setPlayer(null);
    setDeviceId(null);
    setCurrentTrackId(null);
    setIsPaused(true);
    setSongs([]);
    setPlaylistUrl("");
    setError("");
    window.history.replaceState({}, "", "/");
  };

  // Dismisses the "playlist finished" popup and resets the screen back
  // to the paste-a-link view, ready to shuffle a new playlist. Keeps
  // the user logged in and the player connected — only the song list
  // and current track get cleared.
  const handleContinueAfterCompletion = () => {
    setShowCompletionModal(false);
    completionShownRef.current = false;
    wasPlayingRef.current = false;
    hasProgressedRef.current = false;
    setSongs([]);
    setPlaylistUrl("");
    setCurrentTrackId(null);
    setError("");
  };

  if (!token) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
        style={{ background: "radial-gradient(ellipse at 50% 30%, #16181c 0%, #0a0a0c 65%)" }}
      >
        {/* Signature element: a slowly spinning vinyl record, rendered
            in pure CSS — a nod to physical shuffle/rotation, not a
            generic gradient blob. Sits behind the login card. */}
        <div
          className="absolute rounded-full"
          style={{
            width: "560px",
            height: "560px",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background:
              "repeating-radial-gradient(circle at center, #1c1e22 0px, #1c1e22 2px, #232529 3px, #232529 6px)",
            boxShadow: "0 0 120px rgba(29,185,84,0.06)",
            animation: "spin 40s linear infinite",
          }}
        >
          <div
            className="absolute rounded-full"
            style={{
              width: "160px",
              height: "160px",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              background: "radial-gradient(circle at 40% 35%, #2bd968 0%, #14251a 70%)",
            }}
          />
          <div
            className="absolute rounded-full bg-black"
            style={{
              width: "18px",
              height: "18px",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          />
        </div>

        <style>{`
          @keyframes spin {
            from { transform: translate(-50%, -50%) rotate(0deg); }
            to { transform: translate(-50%, -50%) rotate(360deg); }
          }
        `}</style>

        {/* Glass card holding the actual content, floating above the
            record so the record reads as atmosphere, not clutter. */}
        <div
          className="relative z-10 flex flex-col items-center text-center px-10 py-14 rounded-3xl max-w-md w-full"
          style={{
            background: "rgba(15,16,19,0.55)",
            backdropFilter: "blur(24px)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
          }}
        >
          <h1
            className="text-6xl mb-4 tracking-tight"
            style={{
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 700,
              color: "#f2f2f0",
            }}
          >
            Serendify
          </h1>
          <p
            className="mb-10 text-[15px] leading-relaxed"
            style={{
              fontFamily: "'Inter', sans-serif",
              color: "#9a9ca3",
            }}
          >
            Frustrated with Spotify's shuffle? Enjoy your favourite
            playlists entirely — with Serendify.
          </p>
          <a
            href="http://127.0.0.1:5000/login"
            className="font-semibold text-base transition-transform duration-150 hover:scale-105 active:scale-95"
            style={{
              fontFamily: "'Inter', sans-serif",
              background: "#1DB954",
              color: "#06170c",
              padding: "16px 44px",
              borderRadius: "999px",
              boxShadow: "0 8px 30px rgba(29,185,84,0.35)",
            }}
          >
            Login with Spotify
          </a>
        </div>
      </div>
    );
  }

  const currentSong = songs.find((s) => s.id === currentTrackId);

  return (
    <>
      {/* Blurred album art background — a plain fixed layer sitting
          behind the app content, swapped whenever the track changes. */}
      <div className="fixed inset-0 z-0 bg-black overflow-hidden">
        {currentSong?.image && (
          <div
            key={currentSong.id}
            className="absolute inset-0 bg-cover bg-center scale-110 blur-xl opacity-40"
            style={{ backgroundImage: `url(${currentSong.image})` }}
          />
        )}
        <div className="absolute inset-0 bg-black/60" />
      </div>

      <div className="relative z-10 min-h-screen text-white flex flex-col items-center px-4 py-12 pb-32">
      <button
        onClick={handleLogout}
        className="absolute top-6 right-6 text-gray-400 hover:text-white text-sm border border-gray-700 rounded-full px-4 py-2"
      >
        Log out
      </button>

      <h1 className="text-5xl font-bold mb-2">Serendify</h1>
      <p className="text-gray-400 mb-10 text-center">
        Paste your playlist and let us do the rest.
      </p>

      <div className="flex gap-3 w-full max-w-2xl mb-10">
        <input
          type="text"
          placeholder="Paste your Spotify playlist link..."
          value={playlistUrl}
          onChange={(e) => setPlaylistUrl(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-full px-5 py-3 text-white outline-none"
        />
        <button
          onClick={handleSerendify}
          className="bg-green-500 hover:bg-green-400 text-black font-bold py-3 px-6 rounded-full"
        >
          {loading ? "Shuffling..." : "Serendify!"}
        </button>
      </div>

      {error && <p className="text-red-400 mb-6">{error}</p>}

      {songs.length > 0 && (
        <div className="w-full max-w-2xl">
          <h2 className="text-xl font-semibold mb-4">
            Your Serendified Playlist
          </h2>
          {songs.map((song, index) => (
            <div
              key={song.id}
              className="flex items-center gap-5 bg-gray-900 rounded-xl p-4 mb-3"
            >
              <span className="text-gray-500 w-6 text-right text-base">
                {index + 1}
              </span>
              {song.image && (
                <img
                  src={song.image}
                  alt={song.name}
                  className="w-16 h-16 rounded-lg object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-lg truncate">{song.name}</p>
                <p className="text-gray-400 text-base truncate">
                  {song.artist}
                </p>
              </div>
              <button
                onClick={() => playQueueFrom(index)}
                className="ml-auto text-green-400 text-base hover:underline shrink-0"
              >
                {currentTrackId === song.id && !isPaused ? "Playing" : "Play"}
              </button>
            </div>
          ))}
        </div>
      )}

      {currentSong && (
        <div className="fixed bottom-0 left-0 w-full bg-gray-900/90 backdrop-blur-lg border-t border-white/10 shadow-[0_-8px_30px_rgba(0,0,0,0.4)] px-6 py-3 rounded-t-2xl">
          <div className="grid grid-cols-3 items-center max-w-4xl mx-auto gap-4">
            {/* Song info */}
            <div className="flex items-center gap-3 min-w-0">
              {currentSong.image && (
                <img
                  src={currentSong.image}
                  alt={currentSong.name}
                  className="w-14 h-14 rounded-lg shadow-md object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold truncate">{currentSong.name}</p>
                <p className="text-gray-400 text-sm truncate">
                  {currentSong.artist}
                </p>
              </div>
            </div>

            {/* Transport controls + seek bar */}
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-5">
                <button
                  onClick={skipPrevious}
                  className="text-gray-400 hover:text-white text-xl transition-colors hover:scale-110 active:scale-95 duration-150"
                  title="Previous"
                >
                  ⏮
                </button>
                <button
                  onClick={togglePlay}
                  className="bg-white text-black w-10 h-10 flex items-center justify-center rounded-full hover:scale-105 active:scale-95 transition-transform shadow-md"
                  title={isPaused ? "Play" : "Pause"}
                >
                  {isPaused ? "▶" : "⏸"}
                </button>
                <button
                  onClick={skipNext}
                  className="text-gray-400 hover:text-white text-xl transition-colors hover:scale-110 active:scale-95 duration-150"
                  title="Next"
                >
                  ⏭
                </button>
              </div>
              <div className="flex items-center gap-2 w-full max-w-md">
                <span className="text-[11px] text-gray-500 w-9 text-right tabular-nums">
                  {formatTime(position)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  value={position}
                  onChange={handleSeek}
                  className="flex-1 h-1 accent-green-500 cursor-pointer"
                />
                <span className="text-[11px] text-gray-500 w-9 tabular-nums">
                  {formatTime(duration)}
                </span>
              </div>
            </div>

            {/* Spacer to balance the grid (keeps controls visually centered) */}
            <div />
          </div>
        </div>
      )}
      </div>

      {showCompletionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl px-8 py-10 max-w-sm w-full text-center">
            <h2 className="text-2xl font-bold mb-3">There you go!</h2>
            <p className="text-gray-300 mb-8">
                You've completed your playlist. Continue to use Serendify.
            </p>
            <button
              onClick={handleContinueAfterCompletion}
              className="bg-green-500 hover:bg-green-400 text-black font-bold py-3 px-8 rounded-full"
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;