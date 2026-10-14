// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The "Paused" switch of each folder already pauses one folder. These actions
// are about what a switch cannot do in one step: pause every folder at once
// (a video call, a game, a metered connection), resume them all, or ask for
// a rescan (after a backup job wrote into a folder whose watcher is off).
// Each takes an optional folder: empty means every folder of Syncthing,
// added to Gladys or not. All of it is reversible; nothing deletes anything.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async pause_folders(hub, { fields = {} }) {
    const folders = hub.targetFolders(fields.folder);
    return { count: await hub.setFoldersPaused(folders, true) };
  },

  async resume_folders(hub, { fields = {} }) {
    const folders = hub.targetFolders(fields.folder);
    return { count: await hub.setFoldersPaused(folders, false) };
  },

  async scan_folders(hub, { fields = {} }) {
    const folders = hub.targetFolders(fields.folder);
    return { count: await hub.scanFolders(folders) };
  },
};
