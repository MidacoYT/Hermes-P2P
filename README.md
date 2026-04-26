# Hermes - P2P File Transfer

Hermes est une application **desktop** de transfert de fichiers peer-to-peer (P2P) qui permet d'envoyer des fichiers directement entre ordinateurs sans passer par un serveur central.

## Fonctionnalités

- **Application Desktop** : Application native Windows/macOS/Linux grâce à Tauri
- **ID Unique par appareil** : Chaque ordinateur a un identifiant unique persistant basé sur son empreinte digitale
- **Connexion P2P directe** : WebRTC pour un transfert direct sans serveur intermédiaire
- **Signaling** : Serveur Socket.IO pour la coordination entre pairs
- **Transfert de fichiers** : Envoi de fichiers avec barre de progression et vitesse de transfert
- **Sécurisé** : Les données ne passent pas par un serveur central
- **Interface native** : Fenêtre sans cadre avec contrôles personnalisés

## Architecture

```
┌─────────────┐      Socket.IO      ┌─────────────┐
│   Sender    │ ◄────Signaling─────►│   Server    │
│  (WebRTC)   │                     │ (Node.js)   │
└──────┬──────┘                     └──────┬──────┘
       │                                    │
       │        WebRTC DataChannel          │
       ◄────────────Direct P2P─────────────►│
                                            │
                                     ┌──────┴──────┐
                                     │  Receiver   │
                                     │  (WebRTC)   │
                                     └─────────────┘
```

## Prérequis

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (pour Tauri)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Windows seulement)

## Installation

### 1. Dépendances Node.js

```bash
npm install
```

### 2. Serveur de Signalisation

```bash
cd server
npm install
npm start
# ou pour le développement :
npm run dev
```

## Développement

### Mode Développement (avec hot-reload)

```bash
# Terminal 1 - Démarrer le serveur de signaling
cd server
npm start

# Terminal 2 - Démarrer l'application Tauri
npm run tauri-dev
```

### Build de Production

```bash
# Build l'application pour la production
npm run tauri-build
```

Les installateurs seront créés dans `src-tauri/target/release/bundle/`.

## Utilisation

1. **Démarrer le serveur** : `cd server && npm start` (port 3001)
2. **Lancer l'application** : Double-cliquez sur l'exécutable ou `npm run tauri-dev`
3. **Envoyer** : Cliquez sur "Create Transfer ID" et partagez votre ID
4. **Recevoir** : Entrez l'ID du sender et cliquez sur "Join"

## Technologies

- **Frontend** : React 19 + TypeScript + TailwindCSS 4 + Vite
- **Desktop Framework** : Tauri v2 (Rust)
- **Signaling** : Node.js + Socket.IO
- **P2P** : WebRTC DataChannel

## Comment ça marche

1. **Génération d'ID** : L'ID est basé sur l'empreinte de l'appareil (userAgent, résolution, timezone, etc.) et stocké de manière persistante
2. **Signaling** : Les pairs s'échangent leurs informations de connexion via le serveur Socket.IO
3. **Connexion P2P** : WebRTC établit une connexion directe entre les ordinateurs
4. **Transfert** : Les fichiers sont envoyés par morceaux (16KB) via le DataChannel WebRTC

## License

MIT
