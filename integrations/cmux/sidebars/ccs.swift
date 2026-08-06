// CCS live-workspace sidebar, V1.
// The projection follows cmux's shipped status-board.swift and finder.swift patterns.
// T3 Sidebar V2 supplies the visual hierarchy, not a parallel rendering architecture.

func hasDirectory(_ w) -> Bool {
  if let directory = w.directory { return directory != "" }
  return false
}

func hasBranch(_ w) -> Bool {
  if let branch = w.branch { return branch != "" }
  return false
}

func hasPR(_ w) -> Bool {
  if let pr = w.pr {
    if let label = pr.label { return label != "" }
  }
  return false
}

func hasProgress(_ w) -> Bool {
  if let progress = w.progress {
    if let value = progress.value { return true }
  }
  return false
}

func hasLatestAt(_ w) -> Bool {
  if let latestAt = w.latestAt { return true }
  return false
}

func hasAgentActivity(_ w) -> Bool {
  if let prompt = w.latestPrompt {
    if prompt != "" { return true }
  }
  if let message = w.latestMessage {
    if message != "" { return true }
  }
  return false
}

func directoryIdentity(_ w) -> String {
  if !hasDirectory(w) { return "Workspace" }
  let parts = w.directory.split(separator: "/")
  if parts.count == 0 { return "Workspace" }
  return String(parts[parts.count - 1])
}

func agoLabel(_ minutes) -> String {
  if minutes < 1 { return "now" }
  if minutes < 60 { return "\(minutes)m" }
  if minutes < 1440 { return "\(minutes / 60)h" }
  return "\(minutes / 1440)d"
}

func workspaceIcon(_ w) -> String {
  if w.pinned { return "pin.fill" }
  if let remote = w.remote {
    if remote.connected == true { return "network" }
  }
  if hasPR(w) { return "arrow.triangle.pull" }
  return "folder.fill"
}

func workspaceTint(_ w) -> String {
  if w.selected { return "#0A84FF" }
  if w.unread > 0 { return "#10B981" }
  if w.dirty == true { return "#34C759" }
  return "#8E8E93"
}

func statusText(_ w) -> String {
  if hasPR(w) { return w.pr.label }
  if hasBranch(w) && w.dirty == true { return "\(w.branch) modified" }
  if hasBranch(w) { return w.branch }
  if w.portCount > 0 { return "\(w.portCount) ports" }
  return "\(w.tabCount) tabs"
}

func laneHeader(_ icon, _ title, _ count) -> some View {
  HStack(spacing: 6) {
    Image(systemName: icon)
      .font(.system(size: 10))
      .foregroundColor(.tertiary)
    Text(title)
      .font(.system(size: 10))
      .fontWeight(.semibold)
      .textCase(.uppercase)
      .foregroundColor(.tertiary)
    Text("\(count)")
      .font(.system(size: 9, design: .monospaced))
      .foregroundColor(.tertiary)
      .padding(3)
      .background { Capsule().foregroundColor("#8E8E93").opacity(0.14) }
    Spacer()
  }
  .padding(4)
}

func agentRow(_ w, _ nowEpoch) -> some View {
  Button(action: { cmux("workspace.select", workspace_id: w.id) }) {
    HStack(alignment: .top, spacing: 7) {
      Image(systemName: workspaceIcon(w))
        .font(.system(size: 11))
        .foregroundColor(workspaceTint(w))
        .frame(width: 15)

      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 5) {
          Text(directoryIdentity(w))
            .font(.system(size: 10))
            .foregroundColor(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer()
          if hasProgress(w) && w.progress.value < 1.0 {
            Text("Working \(Int(w.progress.value * 100))%")
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor("#0EA5E9")
          }
          if !hasProgress(w) && w.unread > 0 {
            Text("\(w.unread) new")
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor("#10B981")
          }
          if !hasProgress(w) && w.unread == 0 && hasLatestAt(w) {
            Text(agoLabel((nowEpoch - w.latestAt) / 60))
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor(.tertiary)
          }
        }

        Text(w.title)
          .font(.system(size: 12))
          .fontWeight(w.selected || w.unread > 0 ? .semibold : .regular)
          .foregroundColor(w.selected ? .primary : .secondary)
          .lineLimit(1)
          .truncationMode(.tail)

        HStack(spacing: 5) {
          if hasBranch(w) {
            Text(w.branch)
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor(.tertiary)
              .lineLimit(1)
              .truncationMode(.tail)
          }
          if w.dirty == true {
            Image(systemName: "pencil")
              .font(.system(size: 8))
              .foregroundColor(.tertiary)
          }
          if hasPR(w) {
            Text(w.pr.label)
              .font(.system(size: 9, design: .monospaced))
              .foregroundColor(w.pr.stale == true ? .tertiary : "#10B981")
          }
          Spacer()
          if let remote = w.remote {
            Image(systemName: "server.rack")
              .font(.system(size: 8))
              .foregroundColor(remote.connected == true ? .tertiary : "#F59E0B")
          }
          if w.portCount > 0 {
            Label("\(w.portCount)", systemImage: "network")
              .font(.system(size: 8, design: .monospaced))
              .foregroundColor(.tertiary)
          }
          if w.tabCount > 1 {
            Label("\(w.tabCount)", systemImage: "rectangle.on.rectangle")
              .font(.system(size: 8, design: .monospaced))
              .foregroundColor(.tertiary)
          }
        }

        if hasProgress(w) && w.progress.value < 1.0 {
          ProgressView(value: w.progress.value, total: 1.0)
            .tint("#0EA5E9")
        }
      }
      Spacer()
    }
    .padding(6)
    .background {
      RoundedRectangle(cornerRadius: 6)
        .foregroundColor(w.selected ? "#0A84FF" : "#000000")
        .opacity(w.selected ? 0.16 : 0.0)
    }
  }
}

func otherRow(_ w) -> some View {
  Button(action: { cmux("workspace.select", workspace_id: w.id) }) {
    HStack(spacing: 7) {
      Image(systemName: workspaceIcon(w))
        .font(.system(size: 11))
        .foregroundColor(workspaceTint(w))
        .frame(width: 15)
      VStack(alignment: .leading, spacing: 1) {
        Text(w.title)
          .font(.system(size: 12))
          .fontWeight(w.selected ? .semibold : .regular)
          .foregroundColor(w.selected ? .primary : .secondary)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(statusText(w))
          .font(.system(size: 9, design: .monospaced))
          .foregroundColor(.tertiary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer()
      if hasProgress(w) && w.progress.value < 1.0 {
        Text("\(Int(w.progress.value * 100))%")
          .font(.system(size: 9, design: .monospaced))
          .foregroundColor("#0EA5E9")
      }
      if !hasProgress(w) && w.unread > 0 {
        Text("\(w.unread)")
          .font(.system(size: 9, design: .monospaced))
          .fontWeight(.semibold)
          .foregroundColor("#10B981")
      }
    }
    .padding(6)
    .background {
      RoundedRectangle(cornerRadius: 6)
        .foregroundColor(w.selected ? "#0A84FF" : "#000000")
        .opacity(w.selected ? 0.14 : 0.0)
    }
  }
}

func agentLane(_ ws, _ nowEpoch) -> some View {
  VStack(alignment: .leading, spacing: 2) {
    laneHeader("sparkles", "Agent activity", ws.count)
    if ws.count == 0 {
      Text("No current agent signals")
        .font(.system(size: 10))
        .foregroundColor(.tertiary)
        .padding(4)
    }
    ForEach(ws.prefix(20)) { w in
      agentRow(w, nowEpoch)
    }
    if ws.count > 20 {
      Text("Showing \(20) of \(ws.count)")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
        .padding(4)
    }
  }
}

func otherLane(_ ws) -> some View {
  VStack(alignment: .leading, spacing: 2) {
    laneHeader("terminal", "Other workspaces", ws.count)
    ForEach(ws.prefix(30)) { w in
      otherRow(w)
    }
    if ws.count > 30 {
      Text("Showing \(30) of \(ws.count)")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
        .padding(4)
    }
  }
}

VStack(alignment: .leading, spacing: 5) {
  HStack(spacing: 6) {
    Image(systemName: "rectangle.stack.fill")
      .font(.system(size: 12))
      .foregroundColor(.secondary)
    Text("CCS")
      .font(.system(size: 13))
      .fontWeight(.semibold)
    Spacer()
    if unreadTotal > 0 {
      Text("\(unreadTotal) new")
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor("#10B981")
    }
    Text("\(workspaceCount)")
      .font(.system(size: 10, design: .monospaced))
      .foregroundColor(.tertiary)
  }
  .padding(6)

  Divider()

  let boardWorkspaces = workspaces.prefix(50)
  let agentActivity = boardWorkspaces.filter { hasAgentActivity($0) }
  let otherWorkspaces = boardWorkspaces.filter { hasAgentActivity($0) == false }

  agentLane(agentActivity, clock.epoch)
  Divider()
  otherLane(otherWorkspaces)

  if workspaceCount > 50 {
    Text("Showing first \(50) of \(workspaceCount) workspaces")
      .font(.system(size: 9))
      .foregroundColor(.tertiary)
      .frame(maxWidth: .infinity)
      .padding(6)
  }

  Spacer()
}
.padding(6)
