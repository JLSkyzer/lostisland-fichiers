// Côté PC : lecture des dossiers, parcours récursif et empreintes SHA-1 calculées en flux.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const contrat = require("./contrat");

// Contenu d'un dossier : les éléments cachés ou système sont montrés mais marqués « ignore » (jamais envoyés).
async function lister(dossier) {
  const entrees = await fs.promises.readdir(dossier, { withFileTypes: true });
  const r = [];
  await Promise.all(
    entrees.map(async (e) => {
      const complet = path.join(dossier, e.name);
      try {
        const st = await fs.promises.stat(complet);
        const estDossier = st.isDirectory();
        if (!estDossier && !st.isFile()) return;
        r.push({ nom: e.name, dossier: estDossier, taille: estDossier ? null : st.size, modifie: st.mtime.toISOString(), ignore: contrat.ignore(e.name) });
      } catch {
        /* lien cassé, fichier système inaccessible : pas montré */
      }
    }),
  );
  return r;
}

/* Tous les fichiers sous un dossier, sans les ignorés (ni ce qu'ils contiennent).
   Renvoie { fichiers: [{ chemin (relatif, « / »), abs, taille, modifieMs }], dossiers: [chemins relatifs] }. */
async function parcourir(racine, { signal } = {}) {
  const fichiers = [];
  const dossiers = [];
  async function visiter(abs, rel) {
    if (signal?.aborted) throw Object.assign(new Error("Annulé."), { name: "AbortError" });
    const entrees = await fs.promises.readdir(abs, { withFileTypes: true });
    for (const e of entrees) {
      if (contrat.ignore(e.name)) continue;
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try {
        st = await fs.promises.stat(a);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dossiers.push(r);
        await visiter(a, r);
      } else if (st.isFile()) fichiers.push({ chemin: r, abs: a, taille: st.size, modifieMs: st.mtimeMs });
    }
  }
  await visiter(racine, "");
  return { fichiers, dossiers };
}

async function sha1(fichier, signal) {
  const h = crypto.createHash("sha1");
  await pipeline(fs.createReadStream(fichier), h, { signal });
  return h.digest("hex");
}

module.exports = { lister, parcourir, sha1 };
