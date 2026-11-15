import { useParams } from '@void/react';
import PlanPage from '../../src/sharing/PlanPage.tsx';

export default function Page() {
  const { slug } = useParams<'/p/[slug]'>();
  return <PlanPage key={slug} slug={slug} />;
}
