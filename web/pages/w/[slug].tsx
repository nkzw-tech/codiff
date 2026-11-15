import { useParams } from '@void/react';
import WalkthroughPage from '../../src/sharing/WalkthroughPage.tsx';

export default function Page() {
  const { slug } = useParams<'/w/[slug]'>();
  return <WalkthroughPage key={slug} slug={slug} />;
}
