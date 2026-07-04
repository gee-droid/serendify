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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const accessToken = params.get("access_token");
    if (accessToken) {
      setToken(accessToken);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    const initPlayer = () => {
      const spotifyPlayer = new window.Spotify.Player({
        name: "Serendify Player",
        getOAuthToken: (cb) => cb(token),
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

        prevTrackIdRef.current = newTrackId;
        setCurrentTrackId(newTrackId);
        setIsPaused(state.paused);
        setPosition(state.position);
        setDuration(state.duration);
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
      const response = await fetch("http://127.0.0.1:5000/shuffle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
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

  const playQueueFrom = async (index, songList = songs) => {
    if (!deviceId) return;
    // A direct play call takes precedence — drop any reshuffle that
    // was waiting to take over once the previous song ended.
    pendingSongsRef.current = null;
    const MAX_QUEUE_SIZE = 500;
    const uris = songList
      .slice(index, index + MAX_QUEUE_SIZE)
      .map((s) => `spotify:track:${s.id}`);
    await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ uris }),
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
    setPlayer(null);
    setDeviceId(null);
    setCurrentTrackId(null);
    setIsPaused(true);
    setSongs([]);
    setPlaylistUrl("");
    setError("");
    window.history.replaceState({}, "", "/");
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-4">
        <h1 className="text-6xl font-bold mb-4">Serendify</h1>
        <p className="text-gray-400 text-xl mb-2 text-center">
          Spotify's shuffle is broken.
        </p>
        <p className="text-gray-400 text-xl mb-10 text-center">We fixed it.</p>
        <a
          href="http://127.0.0.1:5000/login"
          className="bg-green-500 hover:bg-green-400 text-black font-bold py-4 px-10 rounded-full text-lg"
        >
          Login with Spotify
        </a>
      </div>
    );
  }

  const currentSong = songs.find((s) => s.id === currentTrackId);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center px-4 py-12 pb-32 relative">
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

      <div className="flex gap-3 w-full max-w-xl mb-10">
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
        <div className="w-full max-w-xl">
          <h2 className="text-xl font-semibold mb-4">
            Your Serendified Playlist
          </h2>
          {songs.map((song, index) => (
            <div
              key={song.id}
              className="flex items-center gap-4 bg-gray-900 rounded-xl p-3 mb-3"
            >
              <span className="text-gray-500 w-6 text-right">
                {index + 1}
              </span>
              {song.image && (
                <img
                  src={song.image}
                  alt={song.name}
                  className="w-12 h-12 rounded-lg"
                />
              )}
              <div>
                <p className="font-semibold">{song.name}</p>
                <p className="text-gray-400 text-sm">{song.artist}</p>
              </div>
              <button
                onClick={() => playQueueFrom(index)}
                className="ml-auto text-green-400 text-sm hover:underline"
              >
                {currentTrackId === song.id && !isPaused ? "Playing" : "Play"}
              </button>
            </div>
          ))}
        </div>
      )}

      {currentSong && (
        <div className="fixed bottom-0 left-0 w-full bg-gray-900 border-t border-gray-700 px-6 py-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 w-full max-w-3xl mx-auto">
            <span className="text-xs text-gray-400 w-10 text-right">
              {formatTime(position)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={position}
              onChange={handleSeek}
              className="flex-1 accent-green-500"
            />
            <span className="text-xs text-gray-400 w-10">
              {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {currentSong.image && (
              <img
                src={currentSong.image}
                alt={currentSong.name}
                className="w-12 h-12 rounded-lg"
              />
            )}
            <div className="flex-1">
              <p className="font-semibold">{currentSong.name}</p>
              <p className="text-gray-400 text-sm">{currentSong.artist}</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={skipPrevious}
                className="text-gray-300 hover:text-white text-2xl px-2"
                title="Previous"
              >
                ⏮
              </button>
              <button
                onClick={togglePlay}
                className="bg-green-500 hover:bg-green-400 text-black font-bold py-2 px-6 rounded-full"
              >
                {isPaused ? "Play" : "Pause"}
              </button>
              <button
                onClick={skipNext}
                className="text-gray-300 hover:text-white text-2xl px-2"
                title="Next"
              >
                ⏭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;