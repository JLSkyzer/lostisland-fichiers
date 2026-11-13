// Préparation des tâches de la file : ce qu'il faut envoyer, télécharger ou supprimer, dossiers compris.
// Et la synchronisation : aperçu calculé d'abord, appliqué ensuite seulement.
const fs = require("node:fs");
const path = require("node:path");
const contrat = require("./contrat");
const local = require("./local");
const { ErreurApi, traduire } = require("./api");

/* Envoi de fichiers et dossiers locaux (chemins absolus) dans le dossier distant. */
function preparerEnvoi(chemins, dossierDistant) {
  return async (signal) => {
    const ops = [];
    for (const abs of chemins) {
      const nom = path.basename(abs);
      if (contrat.ignore(nom)) continue;
      const refus = contrat.refusNom(nom);
      if (refus) throw new ErreurApi(`« ${nom} » : ${refus}`);
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch (e) {
        throw traduire(e);
      }
      const cible = contrat.joindre(dossierDistant, nom);
      if (st.isFile()) {
        ops.push({ type: "envoi", local: abs, distant: cible, taille: st.size });
        continue;
      }
      if (!st.isDirectory()) continue;
      const { fichiers, dossiers } = await local.parcourir(abs, { signal });
      ops.push({ type: "dossier", distant: cible });
      // Les dossiers vides aussi ; ceux qui contiennent des fichiers sont créés par l'envoi lui-même.
      const pleins = new Set();
      for (const f of fichiers) {
        const s = f.chemin.split("/");
        for (let i = 1; i < s.length; i++) pleins.add(s.slice(0, i).join("/"));
      }
      for (const d of dossiers) if (!pleins.has(d)) ops.push({ type: "dossier", distant: contrat.joindre(cible, d) });
      for (const f of fichiers) ops.push({ type: "envoi", local: f.abs, distant: contrat.joindre(cible, f.chemin), taille: f.taille });
    }
    return ops;
  };
}

/* Téléchargement d'éléments distants ([{ chemin, dossier, taille }]) dans le dossier local. */
function preparerTelechargement(client, elements, dossierLocal) {
  return async () => {
    const ops = [];
    for (const el of elements) {
      const nom = contrat.nomDe(el.chemin);
      const cible = path.join(dossierLocal, nom);
      if (!el.dossier) {
        ops.push({ type: "telechargement", distant: el.chemin, local: cible, taille: el.taille ?? 0 });
        continue;
      }
      const { fichiers } = await client.listeRecursive(el.chemin);
      ops.push({ type: "dossierLocal", local: cible });
      for (const f of fichiers) {
        ops.push({ type: "telechargement", distant: contrat.joindre(el.chemin, f.chemin), local: path.join(cible, ...f.chemin.split("/")), taille: f.taille });
      }
    }
    return ops;
  };
}

/* Aperçu de synchronisation du dossier local vers le dossier distant.
   surEtape({ etape, fait, total }) suit l'avancement (parcours, liste du serveur, empreintes). */
async function apercuSynchronisation(client, dossierLocal, dossierDistant, { supprimer = true, signal, surEtape = () => {} } = {}) {
  surEtape({ etape: "Parcours du dossier local" });
  const { fichiers, dossiers } = await local.parcourir(dossierLocal, { signal });
  surEtape({ etape: "Liste des fichiers du serveur" });
  let distant = [];
  try {
    distant = (await client.listeRecursive(dossierDistant)).fichiers ?? [];
  } catch (e) {
    if (e.statut !== 404) throw e; // dossier absent du serveur : tout est à envoyer
  }
  const aHacher = new Set(contrat.aHacher(fichiers, distant));
  const totalOctets = fichiers.filter((f) => aHacher.has(f.chemin)).reduce((s, f) => s + f.taille, 0);
  let fait = 0;
  for (const f of fichiers) {
    if (!aHacher.has(f.chemin)) continue;
    surEtape({ etape: "Calcul des empreintes", fait, total: totalOctets, fichier: f.chemin });
    try {
      f.sha1 = await local.sha1(f.abs, signal);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new ErreurApi(`${f.chemin} : ${traduire(e).message}`);
    }
    fait += f.taille;
  }
  const a = contrat.apercuSync(fichiers, distant, { supprimer, dossiersLocaux: dossiers });
  return { ...a, dossierLocal, dossierDistant, supprimerActive: supprimer };
}

// Opérations d'un aperçu accepté : envois et remplacements, puis suppressions.
function preparerSynchronisation(apercu) {
  return async () => [
    ...[...apercu.envoyer, ...apercu.remplacer].map((f) => ({ type: "envoi", local: f.abs, distant: contrat.joindre(apercu.dossierDistant, f.chemin), taille: f.taille })),
    ...apercu.suppressions.map((c) => ({ type: "supprimer", distant: contrat.joindre(apercu.dossierDistant, c) })),
  ];
}

module.exports = { preparerEnvoi, preparerTelechargement, apercuSynchronisation, preparerSynchronisation };
