import { useState, useEffect } from 'react'
import { BRAND } from '../config/brand.js'

export default function PWAInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState(null)
  const [showBanner, setShowBanner] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isInstalled, setIsInstalled] = useState(false)

  useEffect(() => {
    // Check if already installed as PWA
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true)
      return
    }

    // iOS detection (no beforeinstallprompt event on iOS)
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream
    setIsIOS(ios)

    // Chrome/Android/Desktop install prompt
    const handler = (e) => {
      e.preventDefault()
      setInstallPrompt(e)
      // Show banner after 3 seconds of using the app
      setTimeout(() => setShowBanner(true), 3000)
    }

    window.addEventListener('beforeinstallprompt', handler)

    // On iOS, show after 5 seconds if not dismissed before
    if (ios && !localStorage.getItem('pwa_install_dismissed')) {
      setTimeout(() => setShowBanner(true), 5000)
    }

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!installPrompt) return
    installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') {
      setShowBanner(false)
      setInstallPrompt(null)
    }
  }

  const handleDismiss = () => {
    setShowBanner(false)
    localStorage.setItem('pwa_install_dismissed', '1')
  }

  if (isInstalled || !showBanner) return null

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-80 z-50 bg-surface rounded-2xl shadow-2xl border border-primary-muted p-4 animate-in slide-in-from-bottom duration-300">
      <div className="flex items-start gap-3">
        <img src={BRAND.logo} alt={BRAND.appName} className="w-10 h-10 rounded-xl flex-shrink-0 object-contain bg-primary-soft p-1 border border-primary-muted" />
        <div className="flex-1 min-w-0">
          <p className="font-bold text-fg text-sm">Install {BRAND.appName}</p>
          {isIOS ? (
            <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">
              Tap <span className="font-bold">Share</span> → <span className="font-bold">Add to Home Screen</span> to install and use offline.
            </p>
          ) : (
            <p className="text-xs text-fg-muted mt-0.5 leading-relaxed">
              Install the app to use it offline and get faster access.
            </p>
          )}
        </div>
        <button onClick={handleDismiss} className="text-fg-subtle hover:text-fg-3 flex-shrink-0 text-lg leading-none mt-0.5">×</button>
      </div>
      {!isIOS && installPrompt && (
        <button
          onClick={handleInstall}
          className="mt-3 w-full py-2 bg-primary hover:bg-primary-hover text-white rounded-xl font-bold text-xs transition shadow-md shadow-primary-line"
        >
          📲 Install App
        </button>
      )}
    </div>
  )
}
