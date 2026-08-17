/// Which build of the CLIENT is executing. `macos/install.sh` overwrites this file with the git
/// SHA and build time before compiling and restores the placeholder afterwards, so the checked-in
/// value marks an unstamped IDE build. The footer pairs it with the server's own version: the two
/// SHAs matching (and moving after a deploy) is what rules out "we're still running old code".
enum BuildStamp {
    static let version = "dev"
    static let builtAt = "unstamped"
}
