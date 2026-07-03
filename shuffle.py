import random

def fisher_yates_shuffle(songs):
    songs = songs.copy()
    n = len(songs)
    for i in range(n - 1, 0, -1):
        j = random.randint(0, i)
        songs[i], songs[j] = songs[j], songs[i]
    return songs

def artist_spread(songs):
    reshuffled = []
    remaining = songs.copy()
    last_two_artists = []

    while remaining:
        placed = False
        for song in remaining:
            if song['artist'] not in last_two_artists:
                reshuffled.append(song)
                last_two_artists = (last_two_artists + [song['artist']])[-2:]
                remaining.remove(song)
                placed = True
                break
        
        if not placed:
            # No choice, just add first remaining
            song = remaining.pop(0)
            reshuffled.append(song)
            last_two_artists = (last_two_artists + [song['artist']])[-2:]

    return reshuffled

def shuffle_playlist(songs):
    shuffled = fisher_yates_shuffle(songs)
    spread = artist_spread(shuffled)
    return spread