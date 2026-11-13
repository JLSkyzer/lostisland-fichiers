// Pont entre l'interface et le processus principal : seules ces fonctions sont exposées à la page.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const appel = (canal) => (...args) => ipcRenderer.invoke(canal, ...args);
const ecoute = (canal) => (f) => {
  const h = (_e, d) => f(d);
  ipcRenderer.on(canal, h);
  return () => ipcRenderer.removeListener(canal, h);
};

contextBridge.exposeInMainWorld("li", {
  demarrage: appel("demarrage"),
  connexion: appel("connexion"),
  deconnexion: appel("deconnexion"),

  localDepart: appel("local-depart"),
  localLister: appel("local-lister"),
  localChoisir: appel("local-choisir"),
  localNouveauDossier: appel("local-nouveau-dossier"),
  localOuvrir: appel("local-ouvrir"),
  localInfos: appel("local-infos"),
  // Chemin d'un fichier lâché depuis l'explorateur du système (File.path n'existe plus dans Electron).
  cheminDe: (fichier) => webUtils.getPathForFile(fichier),

  distantLister: appel("distant-lister"),
  distantNouveauDossier: appel("distant-nouveau-dossier"),
  distantRenommer: appel("distant-renommer"),
  distantSupprimer: appel("distant-supprimer"),

  envoyer: appel("envoyer"),
  telecharger: appel("telecharger"),
  annulerTransfert: appel("transfert-annuler"),
  effacerTransferts: appel("transferts-effacer"),

  syncApercu: appel("sync-apercu"),
  syncAnnulerApercu: appel("sync-annuler-apercu"),
  syncAppliquer: appel("sync-appliquer"),

  lien: appel("lien"),
  majVerifier: appel("maj-verifier"),
  majInstaller: appel("maj-installer"),

  surTransferts: ecoute("transferts"),
  surTransfertFini: ecoute("transfert-fini"),
  surSyncEtape: ecoute("sync-etape"),
  surSessionPerdue: ecoute("session-perdue"),
  surMajProgression: ecoute("maj-progression"),
});
