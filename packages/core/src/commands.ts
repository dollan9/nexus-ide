/**
 * commands.ts — defaultCommands() for kommandopaletten (FAS 2.4).
 *
 * Deskriptorer for de VERKLIGA funktionerna, med de genvagar UI:t visar
 * (Ctrl+Shift+P, Ctrl+K, Ctrl+P, Ctrl+Space, Ctrl+`, F1 ...) och gruppvarde.
 */

import type { CommandDescriptor } from "@nexus/protocol";

export function defaultCommands(): CommandDescriptor[] {
  return [
    // Kommandopalett & filer
    { id: "palette.open", title: "Kommandopalett: Öppna", shortcut: "Ctrl+Shift+P", group: "Allmänt", when: "always" },
    { id: "file.open", title: "Öppna fil (snäll sök)", shortcut: "Ctrl+P", group: "Filer", when: "always" },
    { id: "workspace.search", title: "Sök i workspacet (ripgrep)", shortcut: "Ctrl+Shift+F", group: "Filer", when: "always" },
    { id: "file.save", title: "Spara fil", shortcut: "Ctrl+S", group: "Filer", when: "editor" },
    { id: "file.recent", title: "Senaste filer", group: "Filer", when: "always" },

    // Chat & agent
    { id: "chat.open", title: "Öppna NEXUS-chatt", shortcut: "Ctrl+K", group: "Agent", when: "always" },
    { id: "agent.run", title: "Agent: Kör mål", shortcut: "Ctrl+Enter", group: "Agent", when: "always" },
    { id: "agent.mode.ask", title: "Läge: Fråga (skriver ej)", group: "Agent", when: "always" },
    { id: "agent.mode.agent", title: "Läge: Agent", group: "Agent", when: "always" },
    { id: "agent.mode.debug", title: "Läge: Felsök (reproducera→hypotes→fix→verifiera)", group: "Agent", when: "always" },
    { id: "agent.mode.eyes", title: "Läge: Ögon (skärmanalys)", group: "Agent", when: "always" },
    { id: "agent.interrupt", title: "Agent: Avbryt körning", group: "Agent", when: "always" },

    // Godkännande
    { id: "approval.mode.ask", title: "Godkännande: Fråga varje gång", group: "Godkännande", when: "always" },
    { id: "approval.mode.allowlist", title: "Godkännande: Endast allowlist", group: "Godkännande", when: "always" },
    { id: "approval.mode.auto", title: "Godkännande: Auto", group: "Godkännande", when: "always" },

    // Checkpoints
    { id: "checkpoint.create", title: "Checkpoint: Skapa", group: "Checkpoints", when: "always" },
    { id: "checkpoint.list", title: "Checkpoint: Lista", group: "Checkpoints", when: "always" },
    { id: "checkpoint.rollback", title: "Checkpoint: Återställ", group: "Checkpoints", when: "always" },
    { id: "checkpoint.diff", title: "Checkpoint: Jämför", group: "Checkpoints", when: "always" },

    // Terminal
    { id: "terminal.toggle", title: "Terminal: Visa/dölj", shortcut: "Ctrl+`", group: "Terminal", when: "always" },
    { id: "terminal.new", title: "Terminal: Ny", group: "Terminal", when: "terminal" },

    // Autocomplete / inline edit
    { id: "completion.trigger", title: "Triggera autocomplete", shortcut: "Ctrl+Space", group: "Kod", when: "editor" },
    { id: "edit.inline", title: "Redigera markering med instruktion", shortcut: "Ctrl+I", group: "Kod", when: "editor" },

    // Röst & vision
    { id: "voice.record", title: "Röst: Spela in & transkribera", shortcut: "Ctrl+Shift+V", group: "Röst", when: "always" },
    { id: "vision.capture", title: "Vision: Fånga skärm", group: "Vision", when: "always" },
    { id: "vision.analyze", title: "Vision: Analysera skärm", group: "Vision", when: "always" },

    // Modeller & providers
    { id: "model.select", title: "Modell: Välj roll-modell", group: "Modeller", when: "always" },
    { id: "provider.manage", title: "Provider: Hantera nycklar", group: "Modeller", when: "always" },
    { id: "ollama.manage", title: "Ollama: Hämta/dröja modell", group: "Modeller", when: "always" },

    // Inställningar & hjälp
    { id: "settings.open", title: "Inställningar: Öppna", group: "Allmänt", when: "always" },
    { id: "theme.toggle", title: "Tema: Mörk/Ljus/Midnatt", group: "Allmänt", when: "always" },
    { id: "log.open", title: "Öppna debug.log", group: "Allmänt", when: "always" },
    { id: "help.focus", title: "Help & kortkommandon", shortcut: "F1", group: "Allmänt", when: "always" },
  ];
}
