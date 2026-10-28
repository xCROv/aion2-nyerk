# Nyerk Input Overlay

A third-party Nyerk addon that displays keyboard and mouse input in a HUD section. The HUD can be detached into its own movable overlay. Held keys and mouse buttons stay visible until released; wheel ticks appear transiently. In the addon's **Inputs** tab, click the input field to listen, then press keys or click mouse buttons to add them to the allow-list. Click the field again to stop listening; clicking elsewhere in the tab also stops it. **Clear list** removes the allow-list and **Allow all** restores every input. Each selected input has **Add alias**, **Edit alias**, **Timer**, and **Remove** controls. Click the alias button to set the name shown on the overlay. Enable **Timer** to show how long that input has been held, in seconds; the final duration remains visible briefly after release. **Remove** deletes the input from the filter and removes its alias and timer preference. Settings → Addons also includes overlay width, **Show HUD frame**, transparency, **Hide when no input is held**, and **Hide idle prompt**. Turn off **Show HUD frame** to hide Nyerk's outer card; the addon HUD follows the chosen width. Entries appear and disappear without flashing animations.

## Install

1. In Nyerk, open **Settings → Addons → Open folder**.
2. Replace the old `nyerk-input-overlay` folder with this package (keep all files together).
3. Return to Nyerk and choose **Reload** under Addons. If needed, switch on **Input Overlay** and accept the native-addon prompt again.
4. The HUD appears while Aion is open and Nyerk's HUD is enabled. Open its **Inputs** tab to dock or detach it; to move a detached window, open Nyerk's panel to enter HUD move mode, drag the dashed window, and choose **Done**. The tab reports whether the input hooks started.

The overlay works in borderless or windowed mode. Exclusive fullscreen cannot be overlaid by Nyerk.

## Input and privacy

This addon registers a Windows Raw Input background sink while it is enabled, so it can receive key and mouse-button input while another app is in the foreground. Preferences for the allow-list and aliases are saved locally in Nyerk storage. Input events are not saved, sent to the game, or sent over the internet. Turn off **Show keyboard presses** or **Show mouse inputs** in Addons settings to disable that class of input; switch off the addon to stop receiving input entirely.

The addon contains native Python code and Nyerk identifies it as running with full access. Enable it only if you trust the code. No dependencies beyond Nyerk's bundled Python runtime are required.









