import { unstable_useContentManagerContext } from '@strapi/content-manager/strapi-admin';
import * as React from 'react';
import DealImageInput from './deal-image-input';

const DEAL_UID = 'api::deal.deal';

export function createDealAwareMediaInput(
  StandardMediaInput: React.ComponentType<any>,
) {
  return React.forwardRef<any, any>(function DealAwareMediaInput(
    props,
    forwardedRef,
  ) {
    const { model } = unstable_useContentManagerContext();
    if (model === DEAL_UID && props.name === 'dealImage') {
      return (
        <DealImageInput
          name={props.name}
          label={props.label}
          hint={props.hint}
          disabled={props.disabled}
          required={props.required}
          labelAction={props.labelAction}
        />
      );
    }
    return <StandardMediaInput {...props} ref={forwardedRef} />;
  });
}
