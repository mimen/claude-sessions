package ui

// Shot renders a named view at a fixed size for static capture.
func Shot(name string) string {
	m := New()
	m.w, m.h = 132, 40
	m.frame = 3
	m.cursor = 4 // "Port CCS from Work Laptop" (Repos group)
	switch name {
	case "browser":
		m.view, m.preview = ViewGroups, true
	case "nopreview":
		m.view, m.preview = ViewGroups, false
	case "tree":
		m.view = ViewTree
	case "route":
		m.view, m.overlay = ViewGroups, OverlayRoute
	case "help":
		m.overlay = OverlayHelp
	}
	return m.View()
}
