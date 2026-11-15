import { useParams } from '@void/react';
import ConnectPage from '../../src/sharing/ConnectPage.tsx';

export default function Page() {
  const { code } = useParams<'/connect/[code]'>();
  return <ConnectPage code={code} key={code} />;
}
