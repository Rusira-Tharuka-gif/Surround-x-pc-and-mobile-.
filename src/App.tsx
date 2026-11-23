import { useCallback, useState } from 'react';
import { BackdropStage } from './components/BackdropStage';
import { ConverterStudio } from './components/ConverterStudio';
import { SplashScreen } from './components/SplashScreen';
import { WelcomeScreen } from './components/WelcomeScreen';

type AppStage = 'splash' | 'welcome' | 'studio';

export default function App() {
  const [stage, setStage] = useState<AppStage>(() => {
    if (typeof window === 'undefined') return 'splash';
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') return 'studio';
    if (params.get('welcome') === '1') return 'welcome';
    return 'splash';
  });

  const [demoRequestKey, setDemoRequestKey] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const params = new URLSearchParams(window.location.search);
    return params.get('demo') === '1' ? 1 : 0;
  });

  const handleSplashComplete = useCallback(() => {
    setStage((prev) => (prev === 'splash' ? 'welcome' : prev));
  }, []);

  const handleEnterStudio = useCallback(() => {
    setDemoRequestKey(0);
    setStage('studio');
  }, []);

  const handleLaunchWithDemo = useCallback(() => {
    setDemoRequestKey((k) => k + 1);
    setStage('studio');
  }, []);

  return (
    <div className="relative min-h-[100dvh] w-full bg-[#07090E] text-slate-100">
      <BackdropStage />

      {stage === 'splash' && (
        <SplashScreen onComplete={handleSplashComplete} />
      )}

      {stage === 'welcome' && (
        <div className="animate-splash-logo-in">
          <WelcomeScreen
            onEnterStudio={handleEnterStudio}
            onLaunchWithDemo={handleLaunchWithDemo}
          />
        </div>
      )}

      {stage === 'studio' && (
        <div className="animate-splash-logo-in">
          <ConverterStudio
            demoRequestKey={demoRequestKey}
            onReturnWelcome={() => setStage('welcome')}
          />
        </div>
      )}
    </div>
  );
}
