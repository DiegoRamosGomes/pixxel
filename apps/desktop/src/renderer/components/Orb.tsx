export type OrbState = 'idle' | 'thinking' | 'speaking';

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'pronto',
  thinking: 'pensando',
  speaking: 'falando',
};

type Props = { state: OrbState };

export function Orb({ state }: Props) {
  return (
    <>
      <div className={`orb orb--${state}`} aria-label={`assistente ${STATE_LABEL[state]}`}>
        <span className="orb__halo" />
        <span className="orb__halo orb__halo--alt" />
        <span className="orb__core" />
      </div>
      <div className={`orb-state orb-state--${state}`}>{STATE_LABEL[state]}</div>
    </>
  );
}
