/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The welcome page's entry: one port to the worker, one render.

import { mountPage } from '../../ui/page';
import { connectUi } from '../../ui/store';
import { Welcome } from '../../ui/welcome/Welcome';

mountPage('welcome.document_title', <Welcome ui={connectUi()} />);
