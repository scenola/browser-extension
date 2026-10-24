/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings page's entry: one port to the worker, one render.

import { Options } from '../../ui/options/Options';
import { mountPage } from '../../ui/page';
import { connectUi } from '../../ui/store';

mountPage('options.document_title', <Options ui={connectUi()} />);
